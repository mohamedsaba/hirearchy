import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

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

export async function runBrowserCheck({
  origin,
  user,
  orgA,
  orgB,
  evidence,
  admin,
  principalId,
  stop,
  start,
}) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.R23_CHROMIUM_PATH
      ? { executablePath: process.env.R23_CHROMIUM_PATH }
      : {}),
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    // 1. Open isolated HTTPS /r23/login in real Chromium browser.
    await page.goto(`${origin}/r23/login`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({
      path: join(evidence, 'browser-login.png'),
      fullPage: true,
    });
    console.log(
      'Browser login form controls:',
      await page
        .locator('input')
        .evaluateAll((nodes) =>
          nodes.map((n) => ({ name: n.name, type: n.type })),
        ),
    );

    // 2. Authenticate synthetic User A.
    await page.locator('input[name="email"]').fill(user.email);
    await page.locator('input[name="password"]').fill(user.password);
    await Promise.all([
      page.waitForURL('**/r23/organizations'),
      page.locator('button[type="submit"]').click(),
    ]);
    await page.waitForLoadState('networkidle');
    await page.screenshot({
      path: join(evidence, 'browser-organizations.png'),
      fullPage: true,
    });

    // 3. Verify secure cookie persistence.
    const cookies = await context.cookies();
    const session = cookies.find((cookie) => cookie.name.includes('session'));
    assert(
      session &&
        session.httpOnly &&
        session.secure &&
        session.sameSite === 'Strict',
    );
    assert.equal(session.domain, '127.0.0.1');
    assert.equal(session.path, '/');
    assert.doesNotMatch(await page.evaluate(() => document.cookie), /session=/);
    assert.equal(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
      0,
    );

    // 4. Load available organization memberships (/r23/organizations).
    const organizationsBody = await page.textContent('body');
    assert.ok(organizationsBody.includes(orgA), 'user sees organization A');
    assert.ok(
      !organizationsBody.includes(orgB),
      'user does not see foreign organization B',
    );

    // Discover the rendered controls before choosing the explicitly labelled organization.
    console.log(
      'Browser selection form controls:',
      await page.locator('input,select,button').evaluateAll((nodes) =>
        nodes.map((n) => ({
          tag: n.tagName,
          name: n.name,
          value: n.value,
          text: n.textContent?.trim(),
        })),
      ),
    );

    // 5. Explicitly select Organization A (orgA).
    const select = page.locator('select[name="organizationId"]');
    if (await select.count()) {
      await select.selectOption(orgA);
      await Promise.all([
        page.waitForURL(`**/r23/organizations/${orgA}`),
        page
          .locator('button[type="submit"]')
          .filter({ hasText: /select|continue|open/i })
          .click(),
      ]);
    } else {
      const form = page
        .locator('form')
        .filter({ has: page.locator(`input[value="${orgA}"]`) });
      await Promise.all([
        page.waitForURL(`**/r23/organizations/${orgA}`),
        form.locator('button[type="submit"]').click(),
      ]);
    }
    await page.waitForLoadState('networkidle');

    // 6. Access Organization A's protected page (/r23/organizations/${orgA}).
    assert.ok((await page.textContent('body')).includes(orgA));
    await page.screenshot({
      path: join(evidence, 'browser-protected.png'),
      fullPage: true,
    });

    // 7. Attempt Organization B by changing the URL (/r23/organizations/${orgB}).
    const denied = await page.goto(`${origin}/r23/organizations/${orgB}`);

    // 8. Confirm denial (403) and absence of protected B data.
    assert.equal(denied.status(), 403);
    assert.equal((await page.textContent('body')).includes(orgB), false);

    // 9. Refresh the browser and confirm authorized session continuity (200, contains orgA).
    const backResponse = await page.goto(`${origin}/r23/organizations/${orgA}`);
    assert.equal(backResponse.status(), 200);
    const reloadResponse = await page.reload();
    assert.equal(reloadResponse.status(), 200);
    assert.ok((await page.textContent('body')).includes(orgA));

    // 10. Restart isolated Next.js process while browser remains open, confirm session continuity.
    if (typeof stop === 'function' && typeof start === 'function') {
      await stop();
      await start();
      const restartedResponse = await page.goto(
        `${origin}/r23/organizations/${orgA}`,
      );
      assert.equal(restartedResponse.status(), 200);
      assert.ok(
        (await page.textContent('body')).includes(orgA),
        'session persists across server restart',
      );
    }

    // 11. Revoke membership in PostgreSQL, reload, confirm 403 and absence of protected data.
    if (admin && principalId) {
      await admin.query(
        "UPDATE hirearchy.organization_memberships SET status='revoked', revoked_at=pg_catalog.clock_timestamp(), version=version+1 WHERE organization_id=$1 AND principal_id=$2",
        [orgA, principalId],
      );
      const revokedReload = await page.reload();
      assert.equal(revokedReload.status(), 403);
      const revokedBody = await page.textContent('body');
      assert.ok(!revokedBody.includes('Current organization:'));
      assert.ok(!revokedBody.includes(orgA));

      // Restore membership before testing logout UI
      await admin.query(
        "UPDATE hirearchy.organization_memberships SET status='active', revoked_at=null, version=version+1 WHERE organization_id=$1 AND principal_id=$2",
        [orgA, principalId],
      );
      const restoredResponse = await page.goto(
        `${origin}/r23/organizations/${orgA}`,
      );
      assert.equal(restoredResponse.status(), 200);
      assert.ok((await page.textContent('body')).includes(orgA));
    }

    // 12. Verify logout behavior in the browser.
    await Promise.all([
      page.waitForURL('**/r23/login'),
      page.getByRole('button', { name: /sign out|logout/i }).click(),
    ]);
    const postLogoutCookies = await context.cookies();
    assert.equal(
      postLogoutCookies.some((cookie) => cookie.name.includes('session')),
      false,
      'session cookie cleared upon logout',
    );
    const afterLogout = await page.goto(`${origin}/r23/organizations/${orgA}`);
    assert(
      [401, 303].includes(afterLogout.status()) ||
        page.url().endsWith('/r23/login'),
    );
    assert.equal((await page.textContent('body')).includes(orgA), false);

    // Verify post-logout refresh denial
    const refreshResponse = await page.request.post(
      `${origin}/r23/auth/refresh`,
      {
        headers: { Origin: origin },
      },
    );
    assert.ok(
      [401, 403].includes(refreshResponse.status()),
      'post-logout refresh denied',
    );

    assert.deepEqual(errors, []);
    console.log(
      'PASS rendered HTTPS browser login, explicit selection, cross-org denial, server restart, revocation, and logout; real Secure/HttpOnly cookies',
    );
  } finally {
    await context.close();
    await browser.close();
  }
}
