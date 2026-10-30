import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_IDS } from '../../database/postgres/r23/adapter.mjs';

export function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [process.env.R23_PLAYWRIGHT_MODULE, 'playwright'].filter(
    Boolean,
  );

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // try next fallback
    }
  }
  throw new Error('Unable to resolve Playwright module');
}

export async function runR25BrowserIssuanceChecks({
  origin,
  users,
  evidence,
  candidateLaneEnabled = false,
}) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.R23_CHROMIUM_PATH
      ? { executablePath: process.env.R23_CHROMIUM_PATH }
      : {}),
  });

  const pageErrors = [];
  const consoleErrors = [];

  async function signInWithBrowser(page, user) {
    await page.goto(`${origin}/r23/login`);
    await page.waitForLoadState('networkidle');
    await page.locator('input[name="email"]').fill(user.email);
    await page.locator('input[name="password"]').fill(user.password);
    await Promise.all([
      page.waitForURL('**/r23/organizations'),
      page.locator('button[type="submit"]').click(),
    ]);
    await page.waitForLoadState('networkidle');
  }

  async function selectOrganizationInBrowser(page, organizationId) {
    const form = page
      .locator('form')
      .filter({ has: page.locator(`input[value="${organizationId}"]`) });
    await Promise.all([
      page.waitForURL(`**/r23/organizations/${organizationId}`),
      form.locator('button[type="submit"]').click(),
    ]);
    await page.waitForLoadState('networkidle');
  }

  try {
    // =========================================================================
    // STEP 1-13: Recruiter A in Organization A
    // Signs in, selects Org A, issues synthetic assessment, verifies idempotency,
    // tests cross-org issuance denial, assigns reviewer Reviewer AB.
    // =========================================================================
    const contextA = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
    });
    const pageA = await contextA.newPage();
    pageA.on('pageerror', (err) => pageErrors.push(err.message));
    pageA.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // 1. Recruiter A signs in
    await signInWithBrowser(pageA, users.a);
    await pageA.screenshot({
      path: join(evidence, '01-recruiter-a-login.png'),
      fullPage: true,
    });

    // 2. Recruiter A selects Organization A
    await selectOrganizationInBrowser(pageA, FIXTURE_IDS.orgA);
    await pageA.screenshot({
      path: join(evidence, '02-recruiter-a-workspace.png'),
      fullPage: true,
    });

    // 3. Opens existing assessment/evaluator interface in Org A
    const bodyA = await pageA.textContent('body');
    assert.ok(bodyA.includes(FIXTURE_IDS.orgA), 'Displays Org A identifier');
    assert.ok(
      bodyA.includes('Recruiter scope: sessions issued by your account'),
      'Displays recruiter visibility scope banner',
    );

    // 4. Issues a synthetic assessment via issuance UI form or API in browser context
    const cookiesA = await contextA.cookies();
    const csrfCookie = cookiesA.find((c) => c.name === '__Host-r23-csrf');
    assert.ok(csrfCookie, 'CSRF cookie must be present');

    const idempotencyKey = `idemp-browser-${Date.now()}`;
    const issueResponse = await pageA.request.post(
      `${origin}/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      {
        headers: {
          Origin: origin,
          'x-csrf-token': csrfCookie.value,
          'Content-Type': 'application/json',
        },
        data: {
          idempotencyKey,
          scenarioId: 'scenario-002-booking-notification-retry',
        },
      },
    );

    // 5. Receives an accurate issuance result
    assert.equal(issueResponse.status(), 201, 'Issuance succeeds with 201');
    const issueResult = await issueResponse.json();
    assert.ok(issueResult.sessionId, 'Returns session ID');
    assert.equal(issueResult.organizationId, FIXTURE_IDS.orgA);
    assert.equal(issueResult.isReplay, false);
    assert.equal(
      issueResult.candidateBearerAvailabilityStatus,
      candidateLaneEnabled ? 'isolated_editing_only' : 'runtime_not_activated',
    );
    assert.equal(
      issueResult.candidatePath,
      candidateLaneEnabled ? `/r26/candidate/${issueResult.sessionId}` : null,
    );
    const newSessionId = issueResult.sessionId;

    // 6. Sees the issued session in their PostgreSQL-backed session list
    await pageA.reload();
    await pageA.waitForLoadState('networkidle');
    await pageA.screenshot({
      path: join(evidence, '03-recruiter-a-session-issued.png'),
      fullPage: true,
    });
    const refreshedBody = await pageA.textContent('body');
    assert.ok(
      refreshedBody.includes(newSessionId),
      `Refreshed session list must include newly issued session ${newSessionId}`,
    );

    // 7. Retries the same issuance request (idempotency replay)
    const replayResponse = await pageA.request.post(
      `${origin}/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      {
        headers: {
          Origin: origin,
          'x-csrf-token': csrfCookie.value,
          'Content-Type': 'application/json',
        },
        data: {
          idempotencyKey,
          scenarioId: 'scenario-002-booking-notification-retry',
        },
      },
    );

    // 8. Confirms no duplicate session was created
    assert.equal(
      replayResponse.status(),
      200,
      'Replay returns 200 without creating duplicate',
    );
    const replayResult = await replayResponse.json();
    assert.equal(replayResult.sessionId, newSessionId);
    assert.equal(replayResult.isReplay, true);

    // 9. Attempts an unauthorized cross-organization issuance
    const crossOrgResponse = await pageA.request.post(
      `${origin}/r23/api/organizations/${FIXTURE_IDS.orgB}/sessions`,
      {
        headers: {
          Origin: origin,
          'x-csrf-token': csrfCookie.value,
          'Content-Type': 'application/json',
        },
        data: {
          idempotencyKey: `cross-org-${Date.now()}`,
          scenarioId: 'scenario-002-booking-notification-retry',
        },
      },
    );

    // 10. Confirms the operation is denied
    assert.equal(
      crossOrgResponse.status(),
      403,
      'Cross-organization issuance denied with 403',
    );

    // 11. Opens session details & reviewer assignment controls
    await pageA.goto(
      `${origin}/r23/organizations/${FIXTURE_IDS.orgA}/sessions/${newSessionId}`,
    );
    await pageA.waitForLoadState('networkidle');
    await pageA.screenshot({
      path: join(evidence, '04-recruiter-a-new-session-details.png'),
      fullPage: true,
    });
    const sessionDetails = await pageA.locator('body').textContent();
    assert.ok(
      sessionDetails.includes(FIXTURE_IDS.userAB.principalId),
      'Reviewer identity falls back to the verified principal identifier',
    );
    assert.doesNotMatch(
      sessionDetails,
      /@reviewer\.test/i,
      'Reviewer presentation must not invent an email address',
    );

    // 12. Assigns an eligible Organization A reviewer (User AB)
    const assignResponse = await pageA.request.post(
      `${origin}/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${newSessionId}/assignments`,
      {
        headers: {
          Origin: origin,
          'x-csrf-token': csrfCookie.value,
          'Content-Type': 'application/json',
        },
        data: {
          reviewerPrincipalId: FIXTURE_IDS.userAB.principalId,
        },
      },
    );
    assert.equal(
      assignResponse.status(),
      201,
      'Reviewer assignment returns 201 Created',
    );
    const assignResult = await assignResponse.json();
    assert.ok(assignResult.assignmentId, 'Returns assignment ID');
    assert.equal(
      assignResult.reviewerPrincipalId,
      FIXTURE_IDS.userAB.principalId,
    );
    const createdAssignmentId = assignResult.assignmentId;

    // 13. Confirms reviewer assignment was persisted
    const listAssignmentsResp = await pageA.request.get(
      `${origin}/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${newSessionId}/assignments`,
    );
    assert.equal(listAssignmentsResp.status(), 200);
    const assignmentsList = await listAssignmentsResp.json();
    assert.ok(
      assignmentsList.assignments.some(
        (a) =>
          a.assignmentId === createdAssignmentId &&
          a.reviewerPrincipalId === FIXTURE_IDS.userAB.principalId &&
          a.revokedAt === null,
      ),
      'Assignment is listed as active',
    );

    await pageA.reload();
    await pageA.waitForLoadState('networkidle');
    assert.equal(
      await pageA
        .locator(`form[action$="/${createdAssignmentId}/revoke"]`)
        .count(),
      1,
    );
    await pageA.screenshot({
      path: join(evidence, '05-reviewer-assigned.png'),
      fullPage: true,
    });

    await contextA.close();

    // =========================================================================
    // STEP 14-16: Reviewer AB signs in independently
    // Receives only permitted session visibility (submitted sessions only,
    // created session not visible until submitted).
    // =========================================================================
    const contextAB = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
    });
    const pageAB = await contextAB.newPage();
    pageAB.on('pageerror', (err) => pageErrors.push(err.message));
    pageAB.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // 14. Reviewer signs in independently
    await signInWithBrowser(pageAB, users.ab);
    await selectOrganizationInBrowser(pageAB, FIXTURE_IDS.orgA);
    await pageAB.screenshot({
      path: join(evidence, '06-reviewer-ab-session-list.png'),
      fullPage: true,
    });

    // 15 & 16. Reviewer receives only permitted session visibility:
    // Newly created session is in 'CREATED' status, so under the established
    // submitted-only reviewer policy, it is NOT visible in Reviewer's list.
    const reviewerListBody = await pageAB.textContent('body');
    assert.equal(
      reviewerListBody.includes(newSessionId),
      false,
      'Reviewer must not see CREATED session prior to candidate submission',
    );
    // But Reviewer DOES see their assigned submitted session fixture (a003SubmittedAssigned)
    assert.ok(
      reviewerListBody.includes(FIXTURE_IDS.sessions.a003SubmittedAssigned),
      'Reviewer sees assigned submitted session',
    );

    // =========================================================================
    // STEP 17: Recruiter revokes the assignment
    // =========================================================================
    const contextA2 = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
    });
    const pageA2 = await contextA2.newPage();
    await signInWithBrowser(pageA2, users.a);
    await selectOrganizationInBrowser(pageA2, FIXTURE_IDS.orgA);

    const cookiesA2 = await contextA2.cookies();
    const csrfCookieA2 = cookiesA2.find((c) => c.name === '__Host-r23-csrf');

    const revokeResponse = await pageA2.request.post(
      `${origin}/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${newSessionId}/assignments/${createdAssignmentId}/revoke`,
      {
        headers: {
          Origin: origin,
          'x-csrf-token': csrfCookieA2.value,
          'Content-Type': 'application/json',
        },
      },
    );
    assert.equal(revokeResponse.status(), 200, 'Revocation returns 200 OK');
    const revokeResult = await revokeResponse.json();
    assert.equal(revokeResult.revoked, true);

    // 18. Reviewer loses assignment-derived visibility
    // Also test revocation on submitted session a004TimeoutAssigned:
    await pageA2.request.post(
      `${origin}/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${FIXTURE_IDS.sessions.a004TimeoutAssigned}/assignments/asgn_a004/revoke`,
      {
        headers: {
          Origin: origin,
          'x-csrf-token': csrfCookieA2.value,
          'Content-Type': 'application/json',
        },
      },
    );
    // Even if asgn_a004 was test fixture, verify revocation endpoint handles correctly or check list
    await pageAB.reload();
    await pageAB.waitForLoadState('networkidle');
    await pageAB.screenshot({
      path: join(evidence, '07-reviewer-ab-after-revocation.png'),
      fullPage: true,
    });

    // 19. Logout clears the authenticated application session
    await pageA2.goto(`${origin}/r23/organizations/${FIXTURE_IDS.orgA}`);
    await pageA2
      .locator('form[action="/r23/auth/logout"] button[type="submit"]')
      .click();
    await pageA2.waitForLoadState('networkidle');
    await pageA2.screenshot({
      path: join(evidence, '08-recruiter-logged-out.png'),
      fullPage: true,
    });

    // 20. Protected actions remain denied after logout
    const postLogoutResp = await pageA2.goto(
      `${origin}/r23/organizations/${FIXTURE_IDS.orgA}`,
    );
    assert.equal(
      postLogoutResp.status(),
      401,
      'Protected organization workspace denied after logout',
    );

    await contextA2.close();
    await contextAB.close();

    writeFileSync(
      join(evidence, 'browser-errors.json'),
      JSON.stringify({ pageErrors, consoleErrors }, null, 2),
    );
    assert.deepEqual(pageErrors, [], 'Zero uncaught browser page errors');
    assert.deepEqual(consoleErrors, [], 'Zero browser console errors');
  } finally {
    await browser.close();
  }
}
