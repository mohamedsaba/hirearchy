import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
];

const SCREENSHOT_DIR = '/tmp/hirearchy-ux-screenshots';

export async function runBuyerJourneyAcceptance({
  baseUrl = 'http://localhost:3001',
} = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-network-change-notifier',
    ],
  });
  try {
    await inspectBuyerJourney({ baseUrl, browser });
  } finally {
    await browser.close();
  }
}

async function inspectBuyerJourney({ baseUrl, browser }) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const context = await browser.newContext({
    bypassCSP: true,
    reducedMotion: 'reduce',
  });

  const page = await context.newPage();
  const browserErrors = [];
  let expectingStorageFailure = false;
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (
      expectingStorageFailure &&
      message.text().includes('503 (Service Unavailable)')
    ) {
      return;
    }
    browserErrors.push(message.text());
  });
  const axeSource = fs.readFileSync(
    path.join(process.cwd(), 'node_modules/axe-core/axe.min.js'),
    'utf8',
  );

  async function auditAccessibility(description) {
    await page.evaluate(axeSource);
    const results = await page.evaluate(async () => {
      // @ts-expect-error axe is injected into the window context
      return await window.axe.run(document, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa'],
        },
      });
    });

    const seriousViolations = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    if (seriousViolations.length > 0) {
      console.error(
        `Accessibility violations on ${description}:`,
        JSON.stringify(seriousViolations, null, 2),
      );
    }
    assert.equal(
      results.violations.length,
      0,
      `Expected 0 Axe violations on ${description}, found ${results.violations.length}`,
    );
  }

  async function checkNoHorizontalOverflow(description) {
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return {
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
        hasOverflow: doc.scrollWidth > doc.clientWidth + 1,
      };
    });

    assert.ok(
      !overflow.hasOverflow,
      `Horizontal overflow detected on ${description}: scrollWidth=${overflow.scrollWidth} > clientWidth=${overflow.clientWidth}`,
    );
  }

  const routesToInspect = [
    { path: '/', label: 'homepage' },
    { path: '/products/software', label: 'software-product' },
    { path: '/contact', label: 'contact-page' },
    { path: '/early-access', label: 'early-access-portal' },
    { path: '/privacy', label: 'privacy-draft' },
    { path: '/terms', label: 'terms-draft' },
  ];
  const routeCtas = {
    '/': [['/early-access', 'Request early access']],
    '/products/software': [['/early-access', 'Request early access']],
    '/contact': [['/early-access', 'Request early access']],
    '/early-access': [
      ['/products/software', 'Explore Software'],
      ['/products/software#demo-limits', 'See demo limits'],
    ],
    '/privacy': [['/', 'Back to Hirearchy']],
    '/terms': [['/', 'Back to Hirearchy']],
  };

  console.log(
    '--- Phase 1: Multi-Viewport Inspection & Accessibility Audits ---',
  );
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });

    for (const route of routesToInspect) {
      const url = `${baseUrl}${route.path}`;
      const desc = `${route.label} (${viewport.name} ${viewport.width}x${viewport.height})`;
      console.log(`Auditing: ${desc} at ${url}`);

      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

      for (const [href, label] of routeCtas[route.path] ?? []) {
        const cta = page.getByRole('link', { name: label }).first();
        assert.equal(
          await cta.getAttribute('href'),
          href,
          `${desc} CTA: ${label}`,
        );
      }

      // Check horizontal overflow
      await checkNoHorizontalOverflow(desc);

      // Audit WCAG 2.1 AA accessibility
      await auditAccessibility(desc);

      // Capture screenshot locally
      const screenshotPath = path.join(
        SCREENSHOT_DIR,
        `buyer-${route.label}-${viewport.name}.png`,
      );
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }
  }

  console.log(
    '--- Phase 2: Interactive Early Access Form Submission & Receipt Verification ---',
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/early-access`, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });
  await page.waitForSelector('[data-hydrated="true"]', {
    state: 'attached',
    timeout: 15000,
  });
  await page
    .locator('[data-testid="early-access-submit-button"]')
    .scrollIntoViewIfNeeded();

  // 1. Test validation triggering
  console.log('Testing client validation errors on empty submission...');
  await page.click('[data-testid="early-access-submit-button"]');
  const nameError = page.locator('#error-ea-name');
  await nameError.waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await nameError.textContent(), 'Please enter your name.');
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    'ea-name',
    'Keyboard validation should focus the first invalid field',
  );

  // 2. Fill the form with reserved synthetic values
  console.log('Filling synthetic early-access acceptance request...');
  await page.locator('#ea-name').scrollIntoViewIfNeeded();
  await page.fill('#ea-name', 'Demo Buyer');
  await page.fill('#ea-email', 'buyer@hirearchy.test');
  await page.fill('#ea-company', 'Synthetic Example Team');
  await page.fill('#ea-role', 'Synthetic Engineering Lead');
  await page.check('input[name="teamSize"][value="51-200"]');
  await page.check(
    'input[name="primaryChallenge"][value="ai_authenticity_uncertainty"]',
  );
  await page.fill('#ea-notes', 'Synthetic preview acceptance record.');

  // 3. Submit
  console.log('Submitting early access request...');
  await page
    .locator('[data-testid="early-access-submit-button"]')
    .scrollIntoViewIfNeeded();
  expectingStorageFailure = true;
  const expectedStorageFailure = page.waitForEvent('console', {
    predicate: (message) =>
      message.type() === 'error' &&
      message.text().includes('503 (Service Unavailable)'),
  });
  await page.route('**/api/early-access', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Request storage is unavailable.' }),
    }),
  );
  await page.click('[data-testid="early-access-submit-button"]');
  await expectedStorageFailure;
  const errorAlert = page.locator('[data-testid="early-access-error-alert"]');
  await errorAlert.waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(
    await errorAlert.textContent(),
    'Request storage is unavailable.',
  );
  // The form schedules this focus after React commits the error alert.
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute('data-testid') ===
      'early-access-error-alert',
    null,
    { timeout: 5000 },
  );
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute('data-testid'),
    ),
    'early-access-error-alert',
    'Keyboard focus should move to the form error message',
  );
  await page.unroute('**/api/early-access');
  expectingStorageFailure = false;

  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/early-access') && res.status() === 201,
    ),
    page.click('[data-testid="early-access-submit-button"]'),
  ]);

  const responseJson = await response.json();
  assert.equal(responseJson.ok, true);
  assert.ok(responseJson.submissionId, 'Expected submissionId in response');
  assert.ok(responseJson.message.includes('No email was sent'));

  // 4. Verify receipt display in DOM
  console.log('Verifying receipt display and truthful staging notice...');
  const successPanel = page.locator(
    '[data-testid="early-access-success-panel"]',
  );
  await successPanel.waitFor({ state: 'visible', timeout: 5000 });
  // Success focus is also scheduled after React commits the receipt panel.
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute('data-testid') ===
      'early-access-success-panel',
    null,
    { timeout: 5000 },
  );
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute('data-testid'),
    ),
    'early-access-success-panel',
    'Keyboard focus should move to the success receipt',
  );

  const receiptSubmissionId = page.locator(
    '[data-testid="receipt-submission-id"]',
  );
  assert.equal(
    await receiptSubmissionId.textContent(),
    responseJson.submissionId,
  );

  const smtpNotice = page.locator('[data-testid="receipt-smtp-notice"]');
  assert.ok(
    (await smtpNotice.textContent()).includes('No email was sent'),
    'Expected truthful email boundary notice in success receipt',
  );
  assert.ok(
    (await smtpNotice.textContent()).includes('authorized operator'),
    'Expected operator retrieval notice in success receipt',
  );

  // Capture success receipt screenshot across viewports
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.waitForTimeout(200);
    const receiptScreenshot = path.join(
      SCREENSHOT_DIR,
      `buyer-early-access-success-${viewport.name}.png`,
    );
    await page.screenshot({ path: receiptScreenshot, fullPage: true });
  }

  assert.deepEqual(
    browserErrors,
    [],
    `Browser console and page errors: ${browserErrors.join('; ')}`,
  );

  console.log(
    'PASS: Responsive pages, accessibility, keyboard validation, error and success intake states, and browser console checks verified.',
  );
}
