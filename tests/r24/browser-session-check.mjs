import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIXTURE_IDS,
  revokeReviewerAssignment,
  restoreReviewerAssignment,
  revokeOrganizationMembership,
  restoreOrganizationMembership,
} from '../../database/postgres/r23/adapter.mjs';

function loadPlaywright() {
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

export async function runR24BrowserSessionChecks({
  origin,
  users,
  evidence,
  admin,
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
    // JOURNEY 1: Recruiter A in Organization A (own issued sessions, filters,
    // pagination, bounded summary inspection, cross-org denial, membership revocation)
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

    await signInWithBrowser(pageA, users.a);
    await pageA.screenshot({
      path: join(evidence, '01-recruiter-a-organizations.png'),
      fullPage: true,
    });

    // Verify Secure/HttpOnly/SameSite=Strict cookie in real browser
    const cookiesA = await contextA.cookies();
    const sessionCookieA = cookiesA.find(
      (c) => c.name === '__Host-r23-session',
    );
    assert(
      sessionCookieA &&
        sessionCookieA.httpOnly &&
        sessionCookieA.secure &&
        sessionCookieA.sameSite === 'Strict',
      'Recruiter A session cookie must be Secure, HttpOnly, SameSite=Strict',
    );
    assert.equal(
      await pageA.evaluate(() => localStorage.length + sessionStorage.length),
      0,
      'No tokens in Web Storage',
    );

    await selectOrganizationInBrowser(pageA, FIXTURE_IDS.orgA);
    await pageA.screenshot({
      path: join(evidence, '02-recruiter-a-session-list.png'),
      fullPage: true,
    });

    const bodyA = await pageA.textContent('body');
    assert.ok(bodyA.includes(FIXTURE_IDS.orgA), 'Displays Org A identifier');
    assert.ok(
      bodyA.includes('Recruiter scope: sessions issued by your account'),
      'Displays recruiter visibility scope banner',
    );
    assert.ok(
      bodyA.includes('Showing 5 of 5 sessions'),
      'Recruiter A sees 5 authorized sessions in Org A',
    );
    for (const allowedId of [
      FIXTURE_IDS.sessions.a001Created,
      FIXTURE_IDS.sessions.a002Active,
      FIXTURE_IDS.sessions.a003SubmittedAssigned,
      FIXTURE_IDS.sessions.a004TimeoutAssigned,
      FIXTURE_IDS.sessions.a005SubmittedUnassigned,
    ]) {
      assert.ok(
        bodyA.includes(allowedId),
        `Recruiter A session list must include own issued session ${allowedId}`,
      );
    }
    // Must NOT include peer recruiter A2's session or Org B sessions
    assert.equal(
      bodyA.includes(FIXTURE_IDS.sessions.a006OtherRecruiter),
      false,
      'Recruiter A must not see peer recruiter session',
    );
    assert.equal(
      bodyA.includes(FIXTURE_IDS.sessions.b003SubmittedAssigned),
      false,
      'Recruiter A must not see Org B session',
    );
    // Must not expose candidate tokens or paths
    assert.equal(
      bodyA.includes('/candidate/'),
      false,
      'Session list must not expose candidate invitation paths',
    );

    // Inspect authorized session summary in browser
    await Promise.all([
      pageA.waitForURL(
        `**/r23/organizations/${FIXTURE_IDS.orgA}/sessions/${FIXTURE_IDS.sessions.a003SubmittedAssigned}`,
      ),
      pageA
        .locator(
          `a[href="/r23/organizations/${FIXTURE_IDS.orgA}/sessions/${FIXTURE_IDS.sessions.a003SubmittedAssigned}"]`,
        )
        .first()
        .click(),
    ]);
    await pageA.waitForLoadState('networkidle');
    await pageA.screenshot({
      path: join(evidence, '03-recruiter-a-session-summary.png'),
      fullPage: true,
    });
    const summaryBodyA = await pageA.textContent('body');
    assert.ok(
      summaryBodyA.includes(FIXTURE_IDS.sessions.a003SubmittedAssigned),
    );
    assert.ok(summaryBodyA.includes('Booking notification retry'));
    assert.ok(summaryBodyA.includes('Submitted'));

    // Direct URL navigation to peer recruiter's session in Org A -> 404
    const peerSessionResp = await pageA.goto(
      `${origin}/r23/organizations/${FIXTURE_IDS.orgA}/sessions/${FIXTURE_IDS.sessions.a006OtherRecruiter}`,
    );
    assert.equal(
      peerSessionResp.status(),
      404,
      'Direct navigation to another recruiter session must return 404',
    );
    const peerBody = await pageA.textContent('body');
    assert.equal(
      peerBody.includes('Peer Recruiter'),
      false,
      '404 page must not leak unauthorized session title',
    );

    // Direct URL navigation to Org B session list -> 403
    const crossOrgResp = await pageA.goto(
      `${origin}/r23/organizations/${FIXTURE_IDS.orgB}`,
    );
    assert.equal(
      crossOrgResp.status(),
      403,
      'Direct navigation to foreign Org B must return 403',
    );
    await pageA.screenshot({
      path: join(evidence, '04-recruiter-a-cross-org-denied.png'),
      fullPage: true,
    });

    // Return to Org A and test pagination (`limit=2`)
    const page1Resp = await pageA.goto(
      `${origin}/r23/organizations/${FIXTURE_IDS.orgA}?limit=2`,
    );
    assert.equal(page1Resp.status(), 200);
    const page1Body = await pageA.textContent('body');
    assert.ok(page1Body.includes('Showing 2 of 5 sessions'));
    assert.ok(page1Body.includes(FIXTURE_IDS.sessions.a005SubmittedUnassigned));
    assert.ok(page1Body.includes(FIXTURE_IDS.sessions.a004TimeoutAssigned));
    assert.equal(
      page1Body.includes(FIXTURE_IDS.sessions.a003SubmittedAssigned),
      false,
    );

    await Promise.all([
      pageA.waitForURL(`**/r23/organizations/${FIXTURE_IDS.orgA}?*cursor=*`),
      pageA.getByRole('link', { name: 'Load more sessions' }).click(),
    ]);
    await pageA.waitForLoadState('networkidle');
    const page2Body = await pageA.textContent('body');
    assert.ok(page2Body.includes(FIXTURE_IDS.sessions.a003SubmittedAssigned));
    assert.ok(page2Body.includes(FIXTURE_IDS.sessions.a002Active));
    await pageA.screenshot({
      path: join(evidence, '05-recruiter-a-paginated-page-2.png'),
      fullPage: true,
    });

    await contextA.close();

    // =========================================================================
    // JOURNEY 2: Multi-org User AB (Reviewer in Org A -> Switch to Admin in Org B,
    // live reviewer assignment revocation)
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

    await signInWithBrowser(pageAB, users.ab);
    await selectOrganizationInBrowser(pageAB, FIXTURE_IDS.orgA);
    await pageAB.screenshot({
      path: join(evidence, '06-reviewer-ab-org-a-sessions.png'),
      fullPage: true,
    });

    const bodyABOrgA = await pageAB.textContent('body');
    assert.ok(
      bodyABOrgA.includes(
        'Reviewer scope: submitted sessions actively assigned to you',
      ),
    );
    assert.ok(bodyABOrgA.includes('Showing 2 of 2 sessions'));
    assert.ok(bodyABOrgA.includes(FIXTURE_IDS.sessions.a003SubmittedAssigned));
    assert.ok(bodyABOrgA.includes(FIXTURE_IDS.sessions.a004TimeoutAssigned));
    // Pre-submission assigned session a002Active must NOT be visible to reviewer
    assert.equal(
      bodyABOrgA.includes(FIXTURE_IDS.sessions.a002Active),
      false,
      'Reviewer must not see pre-submission ACTIVE session even when assigned',
    );
    // Revoked assignment session a005SubmittedUnassigned must NOT be visible
    assert.equal(
      bodyABOrgA.includes(FIXTURE_IDS.sessions.a005SubmittedUnassigned),
      false,
      'Reviewer must not see session with revoked assignment',
    );

    // Live assignment revocation on a004TimeoutAssigned -> immediate removal on reload
    await revokeReviewerAssignment(admin, {
      organizationId: FIXTURE_IDS.orgA,
      sessionId: FIXTURE_IDS.sessions.a004TimeoutAssigned,
      reviewerPrincipalId: FIXTURE_IDS.userAB.principalId,
    });
    try {
      const reloadAfterAssignRevoke = await pageAB.reload();
      assert.equal(reloadAfterAssignRevoke.status(), 200);
      const bodyAfterAssignRevoke = await pageAB.textContent('body');
      assert.ok(bodyAfterAssignRevoke.includes('Showing 1 of 1 sessions'));
      assert.ok(
        bodyAfterAssignRevoke.includes(
          FIXTURE_IDS.sessions.a003SubmittedAssigned,
        ),
      );
      assert.equal(
        bodyAfterAssignRevoke.includes(
          FIXTURE_IDS.sessions.a004TimeoutAssigned,
        ),
        false,
        'Revoked assignment must immediately remove session on next request',
      );
      await pageAB.screenshot({
        path: join(evidence, '07-reviewer-ab-after-assignment-revocation.png'),
        fullPage: true,
      });

      const directRevokedSession = await pageAB.goto(
        `${origin}/r23/organizations/${FIXTURE_IDS.orgA}/sessions/${FIXTURE_IDS.sessions.a004TimeoutAssigned}`,
      );
      assert.equal(directRevokedSession.status(), 404);
    } finally {
      await restoreReviewerAssignment(admin, {
        organizationId: FIXTURE_IDS.orgA,
        sessionId: FIXTURE_IDS.sessions.a004TimeoutAssigned,
        reviewerPrincipalId: FIXTURE_IDS.userAB.principalId,
      });
    }

    // Attempt Org B URL directly BEFORE switching organization -> 403 (no permission merging)
    const unswitchedOrgB = await pageAB.goto(
      `${origin}/r23/organizations/${FIXTURE_IDS.orgB}`,
    );
    assert.equal(
      unswitchedOrgB.status(),
      403,
      'User AB must not access Org B before explicitly switching organization',
    );

    // Explicitly switch organization to Org B (where User AB is admin -> blocked under unratified P2)
    await pageAB.goto(`${origin}/r23/organizations`);
    await pageAB.waitForLoadState('networkidle');
    await selectOrganizationInBrowser(pageAB, FIXTURE_IDS.orgB);
    await pageAB.screenshot({
      path: join(evidence, '08-user-ab-org-b-admin-blocked.png'),
      fullPage: true,
    });

    const bodyABOrgB = await pageAB.textContent('body');
    assert.ok(bodyABOrgB.includes(FIXTURE_IDS.orgB));
    assert.ok(bodyABOrgB.includes('Role: admin'));
    assert.ok(
      bodyABOrgB.includes(
        'Organization admin session access remains blocked until P2 access policies are ratified.',
      ),
    );
    assert.ok(bodyABOrgB.includes('Showing 0 of 0 sessions'));
    assert.equal(
      bodyABOrgB.includes(FIXTURE_IDS.sessions.b003SubmittedAssigned),
      false,
      'Admin role must not see Org B sessions under unratified P2 policy',
    );
    assert.equal(
      bodyABOrgB.includes(FIXTURE_IDS.sessions.a003SubmittedAssigned),
      false,
      'Org A permissions must not bleed into Org B',
    );

    await contextAB.close();

    // =========================================================================
    // JOURNEY 3: Empty Recruiter (`recruiter_a_empty`) -> Truthful Empty State
    // & Membership Revocation -> Immediate 403
    // =========================================================================
    const contextEmpty = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
    });
    const pageEmpty = await contextEmpty.newPage();
    pageEmpty.on('pageerror', (err) => pageErrors.push(err.message));
    pageEmpty.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await signInWithBrowser(pageEmpty, users.recruiterEmpty);
    await selectOrganizationInBrowser(pageEmpty, FIXTURE_IDS.orgA);
    await pageEmpty.screenshot({
      path: join(evidence, '09-recruiter-empty-state.png'),
      fullPage: true,
    });

    const emptyBody = await pageEmpty.textContent('body');
    assert.ok(emptyBody.includes('Showing 0 of 0 sessions'));
    assert.ok(
      emptyBody.includes('No authorized sessions in this organization'),
    );
    assert.ok(
      emptyBody.includes(
        'No assessment sessions issued by your recruiter account were found in this organization.',
      ),
    );

    // Revoke membership -> next request returns 403
    await revokeOrganizationMembership(admin, {
      organizationId: FIXTURE_IDS.orgA,
      principalId: FIXTURE_IDS.recruiterAEmpty.principalId,
    });
    try {
      const revokedResp = await pageEmpty.reload();
      assert.equal(revokedResp.status(), 403);
      await pageEmpty.screenshot({
        path: join(evidence, '10-membership-revoked-403.png'),
        fullPage: true,
      });
    } finally {
      await restoreOrganizationMembership(admin, {
        organizationId: FIXTURE_IDS.orgA,
        principalId: FIXTURE_IDS.recruiterAEmpty.principalId,
      });
    }

    await contextEmpty.close();

    writeFileSync(
      join(evidence, 'browser-errors.json'),
      JSON.stringify({ pageErrors, consoleErrors }, null, 2),
    );
    assert.deepEqual(pageErrors, [], 'Zero uncaught browser page errors');
  } finally {
    await browser.close();
  }
}
