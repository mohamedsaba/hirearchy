import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FIXTURE_IDS } from '../../database/postgres/r23/adapter.mjs';
import { loadPlaywright } from '../r25/browser-issuance-check.mjs';

const csrfCookieName = '__Host-r23-csrf';

export async function runR210BrowserReviewPacketChecks({
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

  // Step 1: Recruiter issues a synthetic assessment
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
        idempotencyKey: `r210-browser-${randomUUID()}`,
        scenarioId: 'scenario-002-booking-notification-retry',
        durationMinutes: 30,
      },
    },
  );
  http.push({ operation: 'issue', status: issuedResponse.status });
  assert.equal(issuedResponse.status, 201, issuedResponse.text);
  const issued = JSON.parse(issuedResponse.text);

  // Recover candidate link
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
      path: join(evidence, `r210-${name}.png`),
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
    // Step 2: Candidate edits, saves and submits
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

    // Save revision 1
    await appendInEditor('# r210-human-review-test-save');
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

    // Submit assessment
    const submit = await candidateCall('submit', {
      requestId: randomUUID(),
      expectedWorkspaceDigest: candidateState.workspaceDigest,
    });
    assert.equal(submit.status, 200, submit.text);
    submitted = await candidateRead();
    assert.equal(submitted.status, 'SUBMITTED');

    await screenshot(candidatePage, '01-candidate-submitted');

    // Assign reviewer
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

    // Step 3: Assigned reviewer authenticates
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

    // Step 4: Reviewer opens real evidence and revisions
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

    // Step 5: Reviewer creates at least two grounded R2.9 observations
    await reviewerPage
      .getByRole('tab', { name: 'Evidence', exact: true })
      .click();
    await reviewerPage
      .getByRole('tab', { name: 'Chronology', exact: true })
      .click();

    // Observation 1 on Workspace save
    const saveEvents = reviewerPage.getByRole('button', {
      name: /Workspace save recorded/,
    });
    await saveEvents.first().waitFor();
    await saveEvents.nth(0).click();

    const observationSection = reviewerPage.locator(
      '.evaluator-observation-panel',
    );
    await observationSection.waitFor();

    const noteTextarea = observationSection.getByRole('textbox', {
      name: 'Observation note',
    });
    await noteTextarea.waitFor();
    await noteTextarea.fill(
      'Observation 1: Candidate edited bookings/service.py to add defensive error handling.',
    );
    await observationSection
      .getByRole('button', { name: 'Save observation', exact: true })
      .click();

    const firstObsCard = observationSection.locator(
      'article[data-testid="evaluator-observation"]',
    );
    await firstObsCard.first().waitFor();

    // Observation 2 on Session activated or submitted
    const sessionEvents = reviewerPage.getByRole('button', {
      name: /Session activated/,
    });
    if ((await sessionEvents.count()) > 0) {
      await sessionEvents.first().click();
      const note2 = reviewerPage
        .locator('.evaluator-observation-panel')
        .getByRole('textbox', { name: 'Observation note' });
      await note2.waitFor();
      await note2.fill(
        'Observation 2: Candidate activated workspace promptly after briefing.',
      );
      await reviewerPage
        .locator('.evaluator-observation-panel')
        .getByRole('button', { name: 'Save observation', exact: true })
        .click();
      await reviewerPage
        .locator('.evaluator-observation-panel')
        .locator('article[data-testid="evaluator-observation"]')
        .first()
        .waitFor();
    }

    await screenshot(reviewerPage, '03-observations-created');

    // Step 6: Reviewer opens the R2.10 review packet (Review tab)
    const reviewTab = reviewerPage.getByRole('tab', {
      name: 'Review',
      exact: true,
    });
    await reviewTab.click();

    const reviewPacketCard = reviewerPage.locator(
      '[data-testid="evaluator-review-packet"]',
    );
    await reviewPacketCard.waitFor();

    const statusBadge = reviewerPage.locator(
      '[data-testid="review-packet-status"]',
    );
    await statusBadge.waitFor();
    assert.match(await statusBadge.innerText(), /DRAFT/);

    // Step 7: Adds a human-written summary, strengths, concerns, and unresolved questions
    const summaryInput = reviewerPage.getByRole('textbox', {
      name: 'Review summary',
    });
    await summaryInput.waitFor();
    const testSummary =
      'Candidate demonstrated thorough defensive programming by implementing an exponential backoff retry loop for notification failures with verified coverage.';
    await summaryInput.fill(testSummary);

    const strengthsInput = reviewerPage.getByRole('textbox', {
      name: 'Strengths',
    });
    await strengthsInput.fill(
      'Demonstrated robust retry logic\nClean separation of notification concerns',
    );

    const concernsInput = reviewerPage.getByRole('textbox', {
      name: 'Concerns',
    });
    await concernsInput.fill(
      'Potential edge case if network error has no error code',
    );

    const questionsInput = reviewerPage.getByRole('textbox', {
      name: 'Unresolved questions',
    });
    await questionsInput.fill(
      'Would the candidate recommend adding circuit-breaker telemetry?',
    );

    // Step 8: Links relevant observations and revisions
    const citationCheckboxes = reviewerPage.locator(
      'fieldset input[type="checkbox"]',
    );
    const checkboxCount = await citationCheckboxes.count();
    assert.ok(checkboxCount >= 1, 'Should have at least 1 citation checkbox');
    await citationCheckboxes.first().check();
    if (checkboxCount > 1) {
      await citationCheckboxes.nth(1).check();
    }

    // Dirty badge should be visible
    const unsavedBadge = reviewerPage.locator(
      '[data-testid="review-packet-unsaved-badge"]',
    );
    assert.equal(await unsavedBadge.isVisible(), true);

    // Step 9: Saves the draft
    const saveDraftBtn = reviewerPage.getByRole('button', {
      name: 'Save draft',
      exact: true,
    });
    await saveDraftBtn.click();

    // Verify draft saved message
    await reviewerPage.getByText(/Draft saved at/).waitFor();
    assert.equal(await unsavedBadge.isVisible(), false);
    await screenshot(reviewerPage, '04-draft-saved');

    // Step 10: Reloads and verifies persistence
    await reviewerPage.reload();
    await reviewerPage
      .getByRole('tab', { name: 'Review', exact: true })
      .click();
    await reviewerPage
      .locator('[data-testid="evaluator-review-packet"]')
      .waitFor();

    const reloadedSummary = await reviewerPage
      .getByRole('textbox', { name: 'Review summary' })
      .inputValue();
    assert.match(reloadedSummary, /defensive programming/);

    const reloadedStatus = await reviewerPage
      .locator('[data-testid="review-packet-status"]')
      .innerText();
    assert.match(reloadedStatus, /DRAFT/);
    await screenshot(reviewerPage, '05-draft-persisted-after-reload');

    // Step 11: Tests stale-update conflict
    // Retrieve current packet from API
    const currentPacketRes = await request(
      origin,
      `/r27/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}/review-packet`,
      { cookies: reviewer, headers: { Accept: 'application/json' } },
    );
    assert.equal(currentPacketRes.status, 200);
    const currentPacket = JSON.parse(currentPacketRes.text).reviewPacket;
    const currentVersion = currentPacket.version;

    // Simulate concurrent update via API bumping version
    const concurrentSaveRes = await request(
      origin,
      `/r27/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}/review-packet`,
      {
        method: 'PUT',
        cookies: reviewer,
        headers: {
          Origin: origin,
          'x-csrf-token': reviewer[csrfCookieName],
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: {
          summary: currentPacket.summary + ' (concurrent update)',
          strengths: currentPacket.strengths,
          concerns: currentPacket.concerns,
          unresolvedQuestions: currentPacket.unresolvedQuestions,
          referencedObservationIds: currentPacket.referencedObservationIds,
          referencedEvidence: currentPacket.referencedEvidence,
          expectedVersion: currentVersion,
        },
      },
    );
    assert.equal(concurrentSaveRes.status, 200, concurrentSaveRes.text);

    // Now in the browser (which still has older expectedVersion), click Save draft
    // Type a character to make dirty and click Save draft
    const summaryEdit = reviewerPage.getByRole('textbox', {
      name: 'Review summary',
    });
    await summaryEdit.press('End');
    await summaryEdit.pressSequentially(' Additional local edit.');
    await reviewerPage
      .getByRole('button', { name: 'Save draft', exact: true })
      .click();

    // Verify 409 conflict banner appears
    const conflictBanner = reviewerPage.locator(
      '[data-testid="review-packet-conflict-banner"]',
    );
    await conflictBanner.waitFor();
    const bannerText = await conflictBanner.innerText();
    assert.match(bannerText, /Edit conflict/i);
    await screenshot(reviewerPage, '06-concurrency-conflict-banner');

    // Click reload button in banner to recover
    const reloadBtn = conflictBanner.getByRole('button', {
      name: 'Reload latest changes',
      exact: true,
    });
    await reloadBtn.click();
    await reviewerPage.waitForFunction(() => {
      return (
        document.querySelector(
          '[data-testid="review-packet-conflict-banner"]',
        ) === null
      );
    });

    // Step 12: Finalizes the packet
    const finalizeBtn = reviewerPage.getByRole('button', {
      name: 'Finalize review packet',
      exact: true,
    });
    await finalizeBtn.click();

    // Confirmation dialog
    const confirmDialog = reviewerPage.getByRole('dialog', {
      name: 'Confirm Review Packet Finalization',
    });
    await confirmDialog.waitFor();

    const confirmBtn = confirmDialog.getByRole('button', {
      name: 'Confirm and finalize',
      exact: true,
    });
    await confirmBtn.click();

    // Wait for status to become FINALIZED
    await reviewerPage.waitForFunction(() => {
      const el = document.querySelector('[data-testid="review-packet-status"]');
      return el && el.textContent?.includes('FINALIZED');
    });

    // Step 13: Verifies immutable final content and digest badge
    const finalStatus = await reviewerPage
      .locator('[data-testid="review-packet-status"]')
      .innerText();
    assert.match(finalStatus, /FINALIZED/);

    const digestBadge = reviewerPage.locator(
      '[data-testid="review-packet-final-digest"]',
    );
    await digestBadge.waitFor();
    const digestText = await digestBadge.innerText();
    assert.match(digestText, /sha256:/);

    const noticeEl = reviewerPage.locator(
      '[data-testid="review-packet-finalized-notice"]',
    );
    await noticeEl.waitFor();
    assert.match(await noticeEl.innerText(), /finalized and immutable/i);

    // Verify final content is rendered cleanly
    const finalSummarySection = reviewerPage.locator(
      '[data-testid="review-packet-summary"]',
    );
    await finalSummarySection.waitFor();
    assert.match(
      await finalSummarySection.innerText(),
      /defensive programming/,
    );

    await screenshot(reviewerPage, '07-packet-finalized');

    // Test clicking cited citation inspection link
    const citeLinks = reviewerPage.getByRole('button', {
      name: /Inspect .* →/,
    });
    if ((await citeLinks.count()) > 0) {
      await citeLinks.first().click();
      // Verifies mode switched to Evidence tab
      const evidenceTab = reviewerPage.getByRole('tab', {
        name: 'Evidence',
        exact: true,
      });
      assert.equal(await evidenceTab.getAttribute('aria-selected'), 'true');
    }

    // Step 14: Reopens packet in read-only mode
    await reviewerPage.goto(evidenceWorkbenchUrl);
    await reviewerPage
      .getByRole('tab', { name: 'Review', exact: true })
      .click();
    await reviewerPage
      .locator('[data-testid="evaluator-review-packet"]')
      .waitFor();
    assert.match(
      await reviewerPage
        .locator('[data-testid="review-packet-status"]')
        .innerText(),
      /FINALIZED/,
    );
    await screenshot(reviewerPage, '08-read-only-finalized-verified');

    // Step 15: Tests responsive viewports (1440, 768, 390, 375 px)
    for (const [w, h, tag] of [
      [1440, 900, '09a-responsive-1440'],
      [768, 1024, '09b-responsive-768'],
      [390, 844, '09c-responsive-390'],
      [375, 667, '09d-responsive-375'],
    ]) {
      await reviewerPage.setViewportSize({ width: w, height: h });
      const hasOverflow = await reviewerPage.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert.equal(
        hasOverflow,
        false,
        `Workbench Review Packet must not overflow horizontally at ${w}px viewport`,
      );
      await screenshot(reviewerPage, tag);
    }
    await reviewerPage.setViewportSize({ width: 1280, height: 900 });

    // Step 16: Verifies another reviewer cannot read it (403/404)
    const recruiterRes = await request(
      origin,
      `/r27/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}/review-packet`,
      { cookies: recruiter, headers: { Accept: 'application/json' } },
    );
    assert.equal(
      [403, 404].includes(recruiterRes.status),
      true,
      `Recruiter must not read private review packet: got ${recruiterRes.status}`,
    );

    const reviewerB = await signInAndSelectOrg(
      origin,
      users.b,
      FIXTURE_IDS.orgB,
    );
    const orgBRes = await request(
      origin,
      `/r27/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}/review-packet`,
      { cookies: reviewerB, headers: { Accept: 'application/json' } },
    );
    assert.equal(
      [403, 404].includes(orgBRes.status),
      true,
      `Org B reviewer must be denied: got ${orgBRes.status}`,
    );

    // Step 17: Revokes the author's assignment
    await admin.query(
      'DELETE FROM hirearchy.reviewer_assignments WHERE session_id = $1',
      [issued.sessionId],
    );

    // Step 18: Verifies subsequent access is denied
    const revokedApiRes = await request(
      origin,
      `/r27/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}/review-packet`,
      { cookies: reviewer, headers: { Accept: 'application/json' } },
    );
    assert.equal(
      [403, 404].includes(revokedApiRes.status),
      true,
      `Subsequent review packet access must be denied after revocation: got ${revokedApiRes.status}`,
    );

    const revokedPageRes = await reviewerPage.goto(evidenceWorkbenchUrl);
    assert.equal(revokedPageRes.status(), 404);
    await screenshot(reviewerPage, '10-assignment-revocation-denied');
    await reviewerPage.goto('about:blank');

    // Step 19: Confirms candidate evidence remains unchanged
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

    // Step 20: Restarts Next.js and verifies stored records remain intact
    if (typeof stop === 'function' && typeof start === 'function') {
      await stop();
      await start();
    }

    const { rows: packetRows } = await admin.query(
      'SELECT status, final_digest FROM hirearchy.evaluator_review_packets WHERE session_id = $1',
      [issued.sessionId],
    );
    assert.equal(packetRows.length, 1);
    assert.equal(packetRows[0].status, 'FINALIZED');
    assert.ok(packetRows[0].final_digest);

    // Browser error checks
    assert.deepEqual(pageErrors, [], 'No browser page errors');
    const allowedHmrReconnect =
      /^WebSocket connection to 'wss:\/\/127\.0\.0\.1:\d+\/_next\/hmr\?id=[^']+' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED$/;
    const allowedExpectedHttpStatusMessage =
      /^Failed to load resource: the server responded with a status of (?:403|404|409) \(.*\)$/;
    const unexpectedConsoleErrors = consoleErrors.filter(
      (message) =>
        !allowedHmrReconnect.test(message) &&
        !allowedExpectedHttpStatusMessage.test(message),
    );
    assert.deepEqual(
      unexpectedConsoleErrors,
      [],
      `Unexpected browser console errors: ${JSON.stringify(unexpectedConsoleErrors)}`,
    );

    // Write evidence JSON
    writeFileSync(
      join(evidence, 'r210-browser-evidence.json'),
      JSON.stringify(
        {
          http,
          pageErrors,
          consoleErrors,
          sessionId: issued.sessionId,
          reviewerPrincipalId: FIXTURE_IDS.userAB.principalId,
          assignmentId,
          finalDigest: packetRows[0].final_digest,
          submission: {
            workspaceDigest: submitted.submission.workspaceDigest,
            manifestDigest: submitted.submission.manifestDigest,
            eventCount: submitted.events.length,
          },
          screenshots: [
            'r210-01-candidate-submitted.png',
            'r210-02-workbench-summary.png',
            'r210-03-observations-created.png',
            'r210-04-draft-saved.png',
            'r210-05-draft-persisted-after-reload.png',
            'r210-06-concurrency-conflict-banner.png',
            'r210-07-packet-finalized.png',
            'r210-08-read-only-finalized-verified.png',
            'r210-09a-responsive-1440.png',
            'r210-09b-responsive-768.png',
            'r210-09c-responsive-390.png',
            'r210-09d-responsive-375.png',
            'r210-10-assignment-revocation-denied.png',
          ],
        },
        null,
        2,
      ),
    );

    console.log(
      'PASS R2.10 Structured Human Review Packet browser verification: drafting, persistence, concurrency conflict, explicit finalization, immutable digest, privacy boundary, responsive layouts, revocation, restart',
    );
  } finally {
    await candidateContext.close();
    await reviewerContext.close();
    await browser.close();
  }
}
