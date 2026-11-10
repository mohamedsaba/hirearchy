import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../r25/browser-issuance-check.mjs';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
];

function localArtifactDirectory() {
  const configured = process.env.FOUNDER_UAT_ARTIFACT_DIR?.trim();
  if (!configured) return null;
  if (!isAbsolute(configured)) {
    throw new Error('FOUNDER_UAT_ARTIFACT_DIR must be an absolute local path.');
  }

  const outputDirectory = resolve(configured);
  const repositoryRoot = resolve(
    fileURLToPath(new URL('../..', import.meta.url)),
  );
  const relativePath = relative(repositoryRoot, outputDirectory);
  if (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
  ) {
    throw new Error('Keep Founder UAT screenshots outside the repository.');
  }
  mkdirSync(outputDirectory, { recursive: true });
  return outputDirectory;
}

async function captureScreenshot(page, outputDirectory, name, viewport) {
  if (!outputDirectory) return null;
  await page.setViewportSize(viewport);
  const path = join(outputDirectory, `${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  return path;
}

async function saveScreenshot(
  page,
  outputDirectory,
  screenshots,
  name,
  viewport = viewports[0],
) {
  const path = await captureScreenshot(page, outputDirectory, name, viewport);
  if (path) screenshots.push(path);
}

function loopbackOrigin() {
  if (process.env.FOUNDER_UAT_DISPOSABLE_AUTOMATION !== '1') {
    throw new Error(
      'Set FOUNDER_UAT_DISPOSABLE_AUTOMATION=1 only for the disposable UAT automation runtime.',
    );
  }
  const configured = process.env.FOUNDER_UAT_APP_ORIGIN;
  if (!configured) {
    throw new Error(
      'Set FOUNDER_UAT_APP_ORIGIN to the disposable loopback app.',
    );
  }
  const url = new URL(configured);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback =
    host === 'localhost' ||
    (isIP(host) === 6 && host === '::1') ||
    (isIP(host) === 4 && host.startsWith('127.'));
  if (
    !loopback ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Founder UAT browser runs only against a loopback app origin.',
    );
  }
  return url.origin;
}

async function assertDisposableRuntime(origin) {
  const expectedRunId = process.env.FOUNDER_UAT_AUTOMATION_RUN_ID?.trim();
  if (!expectedRunId) {
    throw new Error(
      'Set FOUNDER_UAT_AUTOMATION_RUN_ID from the disposable runtime launcher.',
    );
  }

  let response;
  try {
    response = await fetch(`${origin}/api/staging/readiness`, {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error(
      'The disposable runtime readiness check could not be reached.',
    );
  }
  const readiness = await response.json().catch(() => null);
  assert.equal(response.status, 200, 'The disposable database must be ready');
  assert.equal(
    readiness?.status,
    'ready',
    'The disposable database must be ready',
  );
  assert.equal(
    readiness?.founderUatAutomationRunId,
    expectedRunId,
    'The app must attest the disposable automation runtime ID before test data is created',
  );
}

function observeProblems(page, problems, label) {
  page.on('pageerror', (error) => problems.push(`${label}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const text = message.text();
      if (text.startsWith('Failed to load resource:')) {
        return;
      }
      problems.push(`${label}: ${text}`);
    }
  });
}

async function goto(page, target, label) {
  try {
    return await page.goto(target, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    const reason = String(error instanceof Error ? error.message : error)
      .split('\n')[0]
      .replace(/https?:\/\/[^\s]+/g, '[address]');
    throw new Error(`${label} could not be opened: ${reason}`);
  }
}

async function audit(page, label) {
  await page.setViewportSize(viewports[0]);
  await page.waitForLoadState('domcontentloaded');
  if (!(await page.evaluate(() => Boolean(window.axe)))) {
    await page.addScriptTag({ content: axeSource });
  }

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const { violations, width } = await page.evaluate(async () => {
      const result = await window.axe.run(document, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21aa'],
        },
      });
      return {
        violations: result.violations.map((item) => ({
          id: item.id,
          impact: item.impact,
          nodes: item.nodes.length,
          targets: item.nodes.map((n) => n.target),
        })),
        width: {
          viewport: document.documentElement.clientWidth,
          document: Math.max(
            document.documentElement.scrollWidth,
            document.body?.scrollWidth ?? 0,
          ),
        },
      };
    });
    assert.deepEqual(
      violations,
      [],
      `${label} has automated accessibility violations at ${viewport.name} width`,
    );
    assert.ok(
      width.document <= width.viewport + 1,
      `${label} overflows at ${viewport.name} width: ${width.document}px > ${width.viewport}px`,
    );
  }
  await page.setViewportSize(viewports[0]);
}

async function clickLink(page, selector, label) {
  const link = page.locator(selector).first();
  await link.waitFor({ state: 'visible' });
  await link.focus();
  await page.keyboard.press('Enter');
  await page.waitForURL((url) => url.pathname.includes(label));
}

async function signup(page, email, password) {
  const form = page.locator('form[action="/r23/signup"]');
  await form.waitFor({ state: 'visible' });
  await form.locator('input[name="email"]').fill(email);
  await form.locator('input[name="password"]').fill(password);
  await form.locator('button[type="submit"]').click();
  await page
    .getByRole('heading', { name: /account registration initiated/i })
    .waitFor();
}

async function signIn(page, email, password, expectedPath) {
  const form = page.locator('form[action="/r23/auth/login"]');
  await form.waitFor({ state: 'visible' });
  await form.locator('input[name="email"]').fill(email);
  await form.locator('input[name="password"]').fill(password);
  await form.locator('button[type="submit"]').click();
  await page.waitForURL((url) => expectedPath(url), { timeout: 15000 });
}

async function openInbox(page, email) {
  const inboxLink = page.locator('a[href^="/r23/mail"]').first();
  if (await inboxLink.isVisible().catch(() => false)) {
    await inboxLink.click();
  } else {
    const mailForm = page.locator('form[action="/r23/mail"]');
    if (await mailForm.isVisible().catch(() => false)) {
      await mailForm.locator('input[name="email"]').fill(email);
      await mailForm.locator('button[type="submit"]').click();
    } else {
      await goto(page, `${new URL(page.url()).origin}/r23/mail?email=${encodeURIComponent(email)}`, 'Local inbox');
    }
  }
  await page.waitForURL(
    (url) => url.pathname === '/r23/mail',
    { timeout: 15000 },
  );
  if (!new URL(page.url()).searchParams.has('email')) {
    const emailInput = page.locator('input[name="email"]');
    await emailInput.fill(email);
    await page.getByRole('button', { name: /open inbox/i }).click();
    await page.waitForURL(
      (url) => url.pathname === '/r23/mail' && url.searchParams.has('email'),
      { timeout: 15000 },
    );
  }
}

async function waitForMailAction(page, label) {
  const action = page.getByRole('button', { name: label, exact: true }).first();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await action.isVisible().catch(() => false)) return action;
    await page.getByRole('button', { name: /refresh inbox/i }).click();
    await page.waitForTimeout(250);
  }
  throw new Error(
    `The local inbox did not show a ${label.toLowerCase()} action.`,
  );
}

async function confirmEmail(page, email) {
  await openInbox(page, email);
  await page.getByText('Account confirmation', { exact: true }).waitFor();
  const confirm = await waitForMailAction(page, 'Confirm email');
  await confirm.click();
  await page.waitForURL(
    (url) =>
      url.pathname === '/r23/login' && url.searchParams.get('verified') === '1',
    { timeout: 15000 },
  );
}

async function createAccountFromLanding({
  browser,
  origin,
  email,
  password,
  problems,
}) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    bypassCSP: true,
    viewport: viewports[0],
  });
  const page = await context.newPage();
  observeProblems(page, problems, 'account');
  await goto(page, `${origin}/`, 'Landing page');
  assert.equal(new URL(page.url()).pathname, '/r23/login');
  await page.locator('a[href="/r23/signup"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForURL((url) => url.pathname === '/r23/signup');
  await signup(page, email, password);
  await confirmEmail(page, email);
  await signIn(
    page,
    email,
    password,
    (url) => url.pathname === '/r23/organizations',
  );
  return { context, page };
}

function authCookiePresent(cookies) {
  return cookies.some((cookie) => cookie.name === '__Host-r23-session');
}

const SERVICE_SOLUTION = `from copy import deepcopy


def move(state, sender, account, reservation, destination, operation, recipient):
    values = (account, reservation, destination, operation, recipient)
    if any(not isinstance(value, str) or not value.strip() for value in values):
        raise ValueError("Move arguments must be nonempty strings")

    reservation_key = (account, reservation)
    operation_key = (account, reservation, operation)
    previous = state.operations.get(operation_key)
    if previous is not None:
        if previous["to"] != destination or previous["recipient"] != recipient:
            raise ValueError("Operation was already accepted with different details")
        payload = deepcopy(previous)
        receipt = None if payload["from"] == payload["to"] else sender.deliver(operation_key, payload)
        return {
            "reservation": reservation,
            "from": payload["from"],
            "to": payload["to"],
            "receipt": receipt,
        }

    if reservation_key not in state.reservations:
        raise ValueError("Unknown reservation")
    if destination not in state.capacities:
        raise ValueError("Unknown destination")

    source = state.reservations[reservation_key]
    if source != destination and state.occupancy(destination) >= state.capacities[destination]:
        raise ValueError("Destination full")

    payload = {
        "account": account,
        "reservation": reservation,
        "from": source,
        "to": destination,
        "recipient": recipient,
    }
    state.operations[operation_key] = deepcopy(payload)
    if source != destination:
        state.transfer(account, reservation, destination)
        receipt = sender.deliver(operation_key, payload)
    else:
        receipt = None

    return {
        "reservation": reservation,
        "from": source,
        "to": destination,
        "receipt": receipt,
    }
`;

const STATE_SOLUTION = `class State:
    def __init__(self, capacities, reservations):
        self.capacities = dict(capacities)
        self.reservations = dict(reservations)
        self.operations = {}

    def occupancy(self, slot):
        return sum(value == slot for value in self.reservations.values())

    def transfer(self, account, reservation, destination):
        key = (account, reservation)
        if key not in self.reservations:
            raise ValueError("Unknown reservation")
        if destination not in self.capacities:
            raise ValueError("Unknown destination")

        source = self.reservations[key]
        if destination == source:
            return source
        if self.occupancy(destination) >= self.capacities[destination]:
            raise ValueError("Destination full")

        self.reservations[key] = destination
        return source
`;

async function editCode(page, text) {
  const editor = page.getByRole('textbox', { name: 'Edit file' });
  await editor.waitFor({ state: 'visible' });
  await editor.fill(text);
}

export async function runFounderUatJourney() {
  const origin = loopbackOrigin();
  await assertDisposableRuntime(origin);
  const runId = randomUUID().slice(0, 8);
  const artifactDirectory = localArtifactDirectory();
  const screenshots = [];
  const ownerEmail = `owner-${runId}@example.test`;
  const reviewerEmail = `reviewer-${runId}@example.test`;
  const outsiderEmail = `outsider-${runId}@example.test`;
  const ownerPassword = `UatOwner-${runId}!234`;
  const reviewerPassword = `UatReviewer-${runId}!234`;
  const outsiderPassword = `UatOutsider-${runId}!234`;
  const resetPassword = `UatReset-${runId}!567`;
  const problems = [];
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
    ...(process.env.R23_CHROMIUM_PATH
      ? { executablePath: process.env.R23_CHROMIUM_PATH }
      : {}),
  });
  const contexts = [];

  try {
    const invalidContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      bypassCSP: true,
    });
    contexts.push(invalidContext);
    const invalidPage = await invalidContext.newPage();
    observeProblems(invalidPage, problems, 'incorrect-login');
    await goto(invalidPage, `${origin}/`, 'Landing page');
    assert.equal(new URL(invalidPage.url()).pathname, '/r23/login');
    await audit(invalidPage, 'sign-in screen');
    await saveScreenshot(
      invalidPage,
      artifactDirectory,
      screenshots,
      `login-${runId}`,
    );
    const signInForm = invalidPage.locator('form[action="/r23/auth/login"]');
    await signInForm
      .locator('input[name="email"]')
      .fill(`missing-${runId}@example.test`);
    await signInForm
      .locator('input[name="password"]')
      .fill(`Wrong-${runId}!234`);
    await signInForm.locator('button[type="submit"]').click();
    await invalidPage.locator('.access-form p[role="alert"]').waitFor();
    assert.equal(
      authCookiePresent(await invalidContext.cookies()),
      false,
      'Incorrect credentials must not create a browser session',
    );

    const missingInviteResponse = await goto(
      invalidPage,
      `${origin}/r23/invitations/accept`,
      'Missing reviewer invitation token',
    );
    assert.equal(
      missingInviteResponse?.status(),
      400,
      'Reviewer invitation without token must return 400',
    );
    await invalidPage.locator('p[role="alert"]').waitFor();

    const invalidCandidateResponse = await goto(
      invalidPage,
      `${origin}/r26/candidate/invalid_session_id`,
      'Invalid candidate session path',
    );
    assert.equal(
      invalidCandidateResponse?.status(),
      404,
      'Invalid candidate session path must return 404',
    );

    await goto(
      invalidPage,
      `${origin}/r23/reset-password`,
      'Reset password without recovery token',
    );
    const unauthResetForm = invalidPage.locator(
      'form[action="/api/founder-uat/auth/reset-password"]',
    );
    await unauthResetForm.locator('input[name="password"]').fill('Attempter123!456');
    await unauthResetForm.locator('button[type="submit"]').click();
    await invalidPage.waitForURL((url) => url.searchParams.get('error') === 'expired');
    await invalidPage.locator('p[role="alert"]').waitFor();

    const ownerContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      bypassCSP: true,
      viewport: viewports[0],
    });
    contexts.push(ownerContext);
    const ownerPage = await ownerContext.newPage();
    observeProblems(ownerPage, problems, 'owner');
    await goto(ownerPage, `${origin}/`, 'Landing page');
    await audit(ownerPage, 'landing sign-in');
    await clickLink(ownerPage, 'a[href="/r23/signup"]', '/r23/signup');
    await audit(ownerPage, 'signup screen');
    await saveScreenshot(
      ownerPage,
      artifactDirectory,
      screenshots,
      `signup-${runId}`,
    );
    await signup(ownerPage, ownerEmail, ownerPassword);

    await ownerPage.locator('a[href="/r23/login"]').click();
    const unverifiedForm = ownerPage.locator('form[action="/r23/auth/login"]');
    await unverifiedForm.locator('input[name="email"]').fill(ownerEmail);
    await unverifiedForm.locator('input[name="password"]').fill(ownerPassword);
    await unverifiedForm.locator('button[type="submit"]').click();
    await ownerPage.locator('.access-form p[role="alert"]').waitFor();
    assert.equal(new URL(ownerPage.url()).pathname, '/r23/login');
    assert.equal(
      authCookiePresent(await ownerContext.cookies()),
      false,
      'An unverified account must not receive an application session',
    );

    await confirmEmail(ownerPage, ownerEmail);
    await signIn(
      ownerPage,
      ownerEmail,
      ownerPassword,
      (url) => url.pathname === '/r23/organizations',
    );
    const bootstrapForm = ownerPage.locator(
      'form[action="/r23/organization/bootstrap"]',
    );
    await bootstrapForm.waitFor({ state: 'visible' });
    await bootstrapForm
      .locator('input[name="displayName"]')
      .fill(`Local Test ${runId}`);
    await bootstrapForm.locator('button[type="submit"]').click();
    await ownerPage.waitForURL((url) =>
      /^\/r23\/organizations\/[0-9a-f-]+$/i.test(url.pathname),
    );
    const organizationPath = new URL(ownerPage.url()).pathname;
    const organizationId = organizationPath.split('/').at(-1);
    assert.ok(organizationId);
    await audit(ownerPage, 'first organization');
    await ownerPage.getByText(`Local Test ${runId}`, { exact: true }).waitFor();
    await saveScreenshot(
      ownerPage,
      artifactDirectory,
      screenshots,
      `recruiter-organization-${runId}`,
    );

    await ownerPage.locator('a[href$="/settings"]').click();
    await ownerPage.waitForURL((url) => url.pathname.endsWith('/settings'));
    await audit(ownerPage, 'reviewer invitation settings');
    await saveScreenshot(
      ownerPage,
      artifactDirectory,
      screenshots,
      `reviewer-invitation-settings-${runId}`,
    );
    await ownerPage
      .getByText(/No email is sent for reviewer invitations/i)
      .waitFor();
    const invitationForm = ownerPage.locator('form').filter({
      has: ownerPage.locator('input[value="create_invitation"]'),
    });
    await invitationForm
      .locator('input[name="targetEmail"]')
      .fill(reviewerEmail);
    await invitationForm.locator('button[type="submit"]').click();
    await ownerPage.waitForLoadState('domcontentloaded');
    const reviewerInviteInput = ownerPage.locator(
      `input[aria-label="Invitation link for ${reviewerEmail}"]`,
    );
    await reviewerInviteInput.waitFor({ state: 'attached' });
    const reviewerInviteUrl = new URL(
      await reviewerInviteInput.inputValue(),
      origin,
    ).toString();
    assert.equal(new URL(reviewerInviteUrl).origin, origin);

    const reviewerContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      bypassCSP: true,
      viewport: viewports[0],
    });
    contexts.push(reviewerContext);
    const reviewerPage = await reviewerContext.newPage();
    observeProblems(reviewerPage, problems, 'reviewer');
    await goto(reviewerPage, reviewerInviteUrl, 'Reviewer invitation');
    await reviewerPage
      .getByRole('heading', { name: /join organization as a reviewer/i })
      .waitFor();
    await reviewerPage
      .getByRole('button', { name: /create an account/i })
      .click();
    await reviewerPage.waitForURL((url) => url.pathname === '/r23/signup');
    assert.equal(new URL(reviewerPage.url()).search, '');
    await signup(reviewerPage, reviewerEmail, reviewerPassword);
    await confirmEmail(reviewerPage, reviewerEmail);
    await signIn(
      reviewerPage,
      reviewerEmail,
      reviewerPassword,
      (url) =>
        url.pathname === '/r23/invitations/accept' &&
        url.searchParams.get('pending') === '1',
    );
    const acceptForm = reviewerPage.locator(
      'form[action="/r23/invitations/accept"]',
    );
    await acceptForm.waitFor({ state: 'visible' });
    assert.equal(await acceptForm.locator('input[name="token"]').count(), 0);
    await acceptForm.locator('button[type="submit"]').click();
    await reviewerPage.waitForURL((url) => url.pathname === organizationPath);
    await reviewerPage.getByText(/Reviewer scope:/).waitFor();
    await reviewerPage
      .getByText(`Local Test ${runId}`, { exact: true })
      .waitFor();
    await audit(reviewerPage, 'reviewer organization');
    await saveScreenshot(
      reviewerPage,
      artifactDirectory,
      screenshots,
      `reviewer-organization-${runId}`,
    );

    const backToOrgLink = ownerPage
      .locator(`a[href="/r23/organizations/${organizationId}"]`)
      .first();
    if (await backToOrgLink.isVisible().catch(() => false)) {
      await backToOrgLink.click();
      await ownerPage.waitForURL((url) => url.pathname === organizationPath);
    }

    await ownerPage.locator('a[href$="/builder"]').first().click();
    await ownerPage.waitForURL((url) => url.pathname.endsWith('/builder'));
    await audit(ownerPage, 'assessment builder');
    await saveScreenshot(
      ownerPage,
      artifactDirectory,
      screenshots,
      `assessment-builder-${runId}`,
    );
    await ownerPage
      .getByLabel('Assessment template')
      .selectOption('reservation-moves-v3');
    await ownerPage.getByLabel('Duration').selectOption('45');
    const aiToggle = ownerPage.locator('#integrated-ai');
    if (await aiToggle.isChecked()) await aiToggle.uncheck();
    await ownerPage.getByTestId('save-draft-button').click();
    await ownerPage
      .getByTestId('draft-status')
      .filter({ hasText: /draft saved/i })
      .waitFor();
    await ownerPage.getByTestId('continue-to-validate-button').click();
    await ownerPage
      .getByTestId('validated-version-display')
      .waitFor({ timeout: 20000 });
    await ownerPage.getByTestId('continue-to-issue-button').click();
    const reviewerSelect = ownerPage.getByTestId('issue-reviewer-select');
    await reviewerSelect.waitFor({ state: 'visible' });
    const invitedReviewerOption = reviewerSelect
      .locator('option')
      .filter({ hasText: reviewerEmail });
    await invitedReviewerOption.waitFor({ state: 'attached' });
    const invitedReviewerLabel = (
      (await invitedReviewerOption.textContent()) ?? ''
    ).trim();
    assert.ok(
      invitedReviewerLabel.includes(reviewerEmail),
      'The eligible reviewer option should show the invited email address',
    );
    const invitedReviewerPrincipalId =
      await invitedReviewerOption.getAttribute('value');
    assert.ok(invitedReviewerPrincipalId);
    await reviewerSelect.selectOption(invitedReviewerPrincipalId);
    const selectedReviewerLabel = await reviewerSelect
      .locator('option:checked')
      .textContent();
    assert.ok(selectedReviewerLabel?.includes(reviewerEmail));
    const issueButton = ownerPage.getByTestId('issue-assessment-button');
    await issueButton.click();
    await ownerPage.getByTestId('issuance-success').waitFor({ timeout: 20000 });
    const sessionId = await ownerPage
      .getByTestId('issued-session-id')
      .textContent();
    assert.ok(sessionId);
    const issuedReviewer = await ownerPage
      .getByTestId('issued-reviewer-principal-id')
      .textContent();
    assert.ok(
      issuedReviewer,
      'The new session must have a named reviewer assignment',
    );

    await ownerPage.getByTestId('candidate-invitation-create').click();
    const candidateLinkInput = ownerPage.getByTestId(
      'candidate-invitation-link',
    );
    await candidateLinkInput.waitFor({ state: 'visible', timeout: 15000 });
    const candidateInvitationUrl = await candidateLinkInput.inputValue();
    assert.equal(new URL(candidateInvitationUrl).origin, origin);

    await ownerPage.getByTestId('back-to-organization-link').click();
    await ownerPage.waitForURL((url) => url.pathname === organizationPath);
    const inspectLink = ownerPage
      .locator(`li[data-session-id="${sessionId}"] a`)
      .filter({ hasText: 'Inspect session' });
    await inspectLink.waitFor({ state: 'visible' });
    const inspectHref = await inspectLink.getAttribute('href');
    assert.ok(inspectHref);

    const candidateContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      bypassCSP: true,
      viewport: viewports[0],
    });
    contexts.push(candidateContext);
    const candidatePage = await candidateContext.newPage();
    observeProblems(candidatePage, problems, 'candidate');
    const candidateCommandRequests = [];
    candidatePage.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (
        request.method() === 'POST' &&
        (/\/execution$/.test(path) || /\/ai$/.test(path))
      ) {
        candidateCommandRequests.push(path);
      }
    });
    await goto(candidatePage, candidateInvitationUrl, 'Candidate invitation');
    await candidatePage.getByTestId('candidate-data-use-notice').waitFor();
    await audit(candidatePage, 'candidate consent screen');
    await saveScreenshot(
      candidatePage,
      artifactDirectory,
      screenshots,
      `candidate-consent-${runId}`,
    );
    assert.match(
      await candidatePage.getByTestId('candidate-data-use-notice').innerText(),
      /task uses sample data/i,
    );
    const consent = candidatePage.getByRole('checkbox', {
      name: /acknowledge and agree/i,
    });
    await consent.focus();
    await candidatePage.keyboard.press('Space');
    assert.equal(await consent.isChecked(), true);
    const activate = candidatePage.getByRole('button', {
      name: 'Activate assessment',
    });
    await activate.focus();
    await candidatePage.keyboard.press('Enter');
    await candidatePage
      .getByText('In progress', { exact: true })
      .waitFor({ timeout: 20000 });
    await candidatePage
      .getByRole('textbox', { name: 'Edit file' })
      .waitFor({ state: 'visible' });

    const saveIntentDropped = { value: false };
    await candidatePage.route(
      `**/r26/api/candidate/${sessionId}`,
      async (route) => {
        const request = route.request();
        let action = null;
        try {
          action = request.postDataJSON()?.action ?? null;
        } catch {
          action = null;
        }
        if (
          request.method() === 'POST' &&
          action === 'save' &&
          !saveIntentDropped.value
        ) {
          const committedResponse = await route.fetch();
          assert.equal(
            committedResponse.status(),
            200,
            'The real save must commit before its response is dropped',
          );
          saveIntentDropped.value = true;
          await route.abort('failed');
          return;
        }
        await route.continue();
      },
    );

    await editCode(candidatePage, SERVICE_SOLUTION);
    await candidatePage
      .getByRole('button', { name: 'Retry save' })
      .waitFor({ timeout: 15000 });
    assert.equal(
      saveIntentDropped.value,
      true,
      'The journey must drop one real committed save response',
    );
    await candidatePage.getByRole('button', { name: 'Retry save' }).click();
    await candidatePage
      .getByText(/Work saved\.|Changes saved automatically\./)
      .waitFor({ timeout: 15000 });
    await candidatePage.reload({ waitUntil: 'domcontentloaded' });
    const serviceEditor = candidatePage.getByRole('textbox', {
      name: 'Edit file',
    });
    await serviceEditor.waitFor({ state: 'visible' });
    assert.match(await serviceEditor.innerText(), /operation_key/);

    await candidatePage
      .getByLabel('Workspace file')
      .selectOption('src/state.py');
    await candidatePage.waitForFunction(
      () => document.querySelector('[aria-label="Edit file"]') !== null,
    );
    await editCode(candidatePage, STATE_SOLUTION);
    await candidatePage
      .getByText(/Work saved\.|Changes saved automatically\./)
      .waitFor({ timeout: 15000 });
    await audit(candidatePage, 'candidate active workspace');
    await saveScreenshot(
      candidatePage,
      artifactDirectory,
      screenshots,
      `candidate-workspace-desktop-${runId}`,
    );
    await saveScreenshot(
      candidatePage,
      artifactDirectory,
      screenshots,
      `candidate-workspace-mobile-${runId}`,
      viewports[2],
    );
    await candidatePage.setViewportSize(viewports[0]);
    const executionStatusBadge = candidatePage.getByTestId(
      'terminal-capability-status',
    );
    await candidatePage.waitForFunction(() => {
      const badge = document.querySelector(
        '[data-testid="terminal-capability-status"]',
      );
      return badge && !/checking availability/i.test(badge.textContent ?? '');
    });
    const executionStatus = await executionStatusBadge.textContent();
    const executionPanel = candidatePage.getByTestId(
      'candidate-execution-panel',
    );
    const runChecks = candidatePage.getByTestId('run-checks-button');
    if (/unavailable/i.test(executionStatus ?? '')) {
      await executionPanel.waitFor({ state: 'detached' });
      assert.equal(
        await runChecks.count(),
        0,
        'Unavailable execution must expose no run action',
      );
    } else {
      assert.match(executionStatus ?? '', /available/i);
      await executionPanel.waitFor({ state: 'visible' });
      await runChecks.waitFor({ state: 'visible' });
    }

    let submissionRequests = 0;
    await candidatePage.route(
      `**/r26/api/candidate/${sessionId}`,
      async (route) => {
        let action = null;
        try {
          action = route.request().postDataJSON()?.action ?? null;
        } catch {
          action = null;
        }
        if (route.request().method() === 'POST' && action === 'submit')
          submissionRequests += 1;
        await route.continue();
      },
    );
    const submitButton = candidatePage.getByRole('button', {
      name: 'Submit assessment',
      exact: true,
    });
    await submitButton.evaluate((button) => {
      button.click();
      button.click();
    });
    await candidatePage
      .getByText('Assessment submitted', { exact: true })
      .first()
      .waitFor({ timeout: 20000 });
    assert.equal(
      submissionRequests,
      1,
      'Double activation must admit only one final submission',
    );
    await candidatePage.reload({ waitUntil: 'domcontentloaded' });
    await candidatePage
      .getByText('Assessment submitted', { exact: true })
      .first()
      .waitFor();
    assert.equal(
      await candidatePage.getByRole('button', { name: 'Save work' }).count(),
      0,
    );
    assert.deepEqual(
      candidateCommandRequests,
      [],
      'The journey does not invoke execution or AI',
    );
    await audit(candidatePage, 'submitted candidate work');

    await reviewerPage.reload({ waitUntil: 'domcontentloaded' });
    const reviewerSessionLink = reviewerPage
      .locator(`li[data-session-id="${sessionId}"] a`)
      .filter({ hasText: 'Inspect session' });
    await reviewerSessionLink.waitFor({ state: 'visible' });
    await reviewerSessionLink.click();
    await reviewerPage.waitForURL((url) =>
      url.pathname.includes(`/sessions/${sessionId}`),
    );
    const openWorkbenchLink = reviewerPage.getByTestId(
      'open-submitted-evidence-workbench-link',
    );
    await openWorkbenchLink.waitFor({ state: 'visible' });
    await openWorkbenchLink.click();
    await reviewerPage.waitForURL((url) =>
      url.pathname.startsWith('/r27/organizations/'),
    );
    await reviewerPage.getByRole('tab', { name: 'Summary' }).waitFor();
    const summaryTab = reviewerPage.getByRole('tab', { name: 'Summary' });
    await summaryTab.focus();
    await reviewerPage.keyboard.press('ArrowRight');
    const evidenceTab = reviewerPage.getByRole('tab', { name: 'Evidence' });
    await evidenceTab.waitFor();
    assert.equal(await evidenceTab.getAttribute('aria-selected'), 'true');
    await audit(reviewerPage, 'review evidence screen');
    await saveScreenshot(
      reviewerPage,
      artifactDirectory,
      screenshots,
      `review-evidence-desktop-${runId}`,
    );
    await saveScreenshot(
      reviewerPage,
      artifactDirectory,
      screenshots,
      `review-evidence-mobile-${runId}`,
      viewports[2],
    );
    await reviewerPage.setViewportSize(viewports[0]);
    await reviewerPage.getByRole('tab', { name: 'Code changes' }).click();
    const serviceRow = reviewerPage
      .locator('.evaluator-source-row')
      .filter({ hasText: 'src/service.py' })
      .last();
    await serviceRow.waitFor({ state: 'visible' });
    await serviceRow.click();
    const observationPanel = reviewerPage.getByRole('region', {
      name: 'Anchored Observations',
    });
    await observationPanel.waitFor({ state: 'visible' });
    const observationText =
      'The saved service revision records an accepted move before delivery and replays the original operation without moving the reservation again.';
    await observationPanel
      .getByRole('textbox', { name: 'Observation note' })
      .fill(observationText);
    await observationPanel
      .getByRole('button', { name: 'Save observation' })
      .click();
    await observationPanel
      .getByText('Observation saved.', { exact: true })
      .waitFor();
    await reviewerPage.getByRole('tab', { name: 'Review' }).focus();
    await reviewerPage.keyboard.press('Enter');
    const packet = reviewerPage.getByTestId('evaluator-review-packet');
    await packet.waitFor({ state: 'visible' });
    await reviewerPage
      .getByRole('heading', { name: 'Structured Human Review Packet' })
      .waitFor();
    const packetObservation = packet.locator('input[type="checkbox"]').first();
    await packetObservation.waitFor({ state: 'visible' });
    await packetObservation.check();
    await packet
      .getByLabel('Review summary')
      .fill(
        'The submitted service and state revisions show a guarded capacity transfer and a replay keyed to the original accepted operation.',
      );
    await packet
      .getByLabel('Strengths')
      .fill(
        'The change preserves the original reservation when the destination is full.',
      );
    const savePacketDraft = packet.getByRole('button', {
      name: 'Save draft',
      exact: true,
    });
    await Promise.all([
      reviewerPage.waitForResponse(
        (response) =>
          response.url().includes('/review-packet') &&
          response.request().method() === 'PUT' &&
          response.status() === 200,
      ),
      savePacketDraft.click(),
    ]);
    await packet
      .getByTestId('review-packet-status')
      .filter({ hasText: 'DRAFT' })
      .waitFor();
    await packet
      .getByRole('button', { name: 'Finalize review packet' })
      .click();
    const confirmation = reviewerPage.getByRole('dialog', {
      name: 'Confirm Review Packet Finalization',
    });
    await confirmation.waitFor({ state: 'visible' });
    await confirmation
      .getByRole('button', { name: 'Confirm and finalize' })
      .click();
    await packet
      .getByTestId('review-packet-finalized-notice')
      .waitFor({ timeout: 15000 });
    await packet
      .getByTestId('review-packet-status')
      .filter({ hasText: 'FINALIZED' })
      .waitFor();
    await audit(reviewerPage, 'finalized human review');
    await reviewerPage.reload({ waitUntil: 'domcontentloaded' });
    await reviewerPage.getByRole('tab', { name: 'Review' }).click();
    await reviewerPage
      .getByTestId('review-packet-status')
      .filter({ hasText: 'FINALIZED' })
      .waitFor();
    await reviewerPage
      .getByTestId('review-packet-cited-observations')
      .getByText(observationText)
      .waitFor();
    await saveScreenshot(
      reviewerPage,
      artifactDirectory,
      screenshots,
      `human-review-packet-desktop-${runId}`,
    );
    await saveScreenshot(
      reviewerPage,
      artifactDirectory,
      screenshots,
      `human-review-packet-mobile-${runId}`,
      viewports[2],
    );
    await reviewerPage.setViewportSize(viewports[0]);

    const outsider = await createAccountFromLanding({
      browser,
      origin,
      email: outsiderEmail,
      password: outsiderPassword,
      problems,
    });
    contexts.push(outsider.context);
    const denied = await goto(
      outsider.page,
      new URL(inspectHref, origin).toString(),
      'Unassigned reviewer session',
    );
    assert.ok(
      [401, 403, 404].includes(denied?.status() ?? 200),
      'An unaffiliated account must not inspect the session',
    );
    assert.equal(
      await outsider.page.getByText(/reservation|candidate evidence/i).count(),
      0,
    );
    await audit(outsider.page, 'unauthorized reviewer denial');

    const crossOrgDenied = await goto(
      outsider.page,
      `${origin}/r23/organizations/${organizationId}`,
      'Cross-organization access denial',
    );
    assert.ok(
      [401, 403, 404].includes(crossOrgDenied?.status() ?? 200),
      'An unaffiliated account must not access another organization',
    );

    const recoveryContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      bypassCSP: true,
      viewport: viewports[0],
    });
    contexts.push(recoveryContext);
    const recoveryPage = await recoveryContext.newPage();
    observeProblems(recoveryPage, problems, 'recovery');
    await goto(recoveryPage, `${origin}/`, 'Landing page');
    await recoveryPage.locator('a[href="/r23/recover"]').click();
    await recoveryPage.waitForURL((url) => url.pathname === '/r23/recover');
    await audit(recoveryPage, 'password recovery request');
    const recoveryForm = recoveryPage.locator('form[action="/r23/recover"]');
    await recoveryForm.locator('input[name="email"]').fill(ownerEmail);
    await recoveryForm.locator('button[type="submit"]').click();
    await recoveryPage
      .getByRole('heading', { name: /password recovery initiated/i })
      .first()
      .waitFor();
    await recoveryPage.locator('a[href^="/r23/mail"]').first().click();
    await recoveryPage.getByRole('button', { name: /open inbox/i }).waitFor();
    if (!(await recoveryPage.locator('input[name="email"]').inputValue())) {
      await recoveryPage.locator('input[name="email"]').fill(ownerEmail);
      await recoveryPage.getByRole('button', { name: /open inbox/i }).click();
    }
    const recoveryAction = await waitForMailAction(
      recoveryPage,
      'Reset password',
    );
    await recoveryAction.click();
    await recoveryPage.waitForURL(
      (url) => url.pathname === '/r23/reset-password',
    );
    await audit(recoveryPage, 'password reset form');
    assert.equal(await recoveryPage.locator('input[name="token"]').count(), 0);

    // Verify recovery credential quarantine: attempting to navigate to authenticated dashboard must fail
    const recoveryAbuse = await goto(
      recoveryPage,
      `${origin}/r23/organizations`,
      'Recovery credential abuse attempt',
    );
    assert.ok(
      [401, 403, 404].includes(recoveryAbuse?.status() ?? 200) ||
        new URL(recoveryPage.url()).pathname !== '/r23/organizations',
      'Recovery credential must not grant access to organization dashboard',
    );
    assert.equal(
      await recoveryPage.locator('button[type="submit"]:has-text("Select")').count(),
      0,
      'Recovery credential must not expose organization dashboard actions',
    );
    await goto(
      recoveryPage,
      `${origin}/r23/reset-password`,
      'Return to password reset form',
    );

    const resetForm = recoveryPage.locator(
      'form[action="/api/founder-uat/auth/reset-password"]',
    );
    await resetForm.locator('input[name="password"]').fill(resetPassword);
    await resetForm.locator('button[type="submit"]').click();
    await recoveryPage.waitForURL(
      (url) =>
        url.pathname === '/r23/login' && url.searchParams.get('reset') === '1',
    );
    await signIn(
      recoveryPage,
      ownerEmail,
      resetPassword,
      (url) => url.pathname === '/r23/organizations',
    );

    // --- Returning user flow: Recruiter ---
    await audit(recoveryPage, 'returning recruiter organizations dashboard');
    const selectOrgButton = recoveryPage.getByRole('button', {
      name: new RegExp(`Select Local Test ${runId}`, 'i'),
    });
    await selectOrgButton.waitFor({ state: 'visible' });
    await selectOrgButton.click();
    await recoveryPage.waitForURL((url) => url.pathname === organizationPath);
    await audit(recoveryPage, 'returning recruiter organization view');
    const recruiterSessionRow = recoveryPage.locator(
      `li[data-session-id="${sessionId}"]`,
    );
    await recruiterSessionRow.waitFor({ state: 'visible' });
    await recruiterSessionRow.getByText('Submitted', { exact: true }).first().waitFor();
    const recruiterInspectLink = recruiterSessionRow.getByRole('link', {
      name: 'Inspect session',
    });
    await recruiterInspectLink.click();
    await recoveryPage.waitForURL((url) =>
      url.pathname.includes(`/sessions/${sessionId}`),
    );
    await recoveryPage
      .locator('[data-testid="session-lifecycle-status"]')
      .filter({ hasText: /Submitted/i })
      .waitFor();
    await audit(recoveryPage, 'returning recruiter session inspect');
    const recruiterSignOut = recoveryPage.locator(
      'form[action="/r23/auth/logout"] button[type="submit"]',
    );
    await recruiterSignOut.waitFor({ state: 'visible' });
    await recruiterSignOut.click();
    await recoveryPage.waitForURL((url) => url.pathname === '/r23/login');

    // --- Returning user flow: Evaluator ---
    const returningReviewerContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      bypassCSP: true,
      viewport: viewports[0],
    });
    contexts.push(returningReviewerContext);
    const returningReviewerPage = await returningReviewerContext.newPage();
    observeProblems(returningReviewerPage, problems, 'returning-reviewer');
    await goto(
      returningReviewerPage,
      `${origin}/`,
      'Landing page returning reviewer',
    );
    await signIn(
      returningReviewerPage,
      reviewerEmail,
      reviewerPassword,
      (url) => url.pathname === '/r23/organizations',
    );
    await audit(
      returningReviewerPage,
      'returning evaluator organizations dashboard',
    );
    const reviewerSelectOrg = returningReviewerPage.getByRole('button', {
      name: new RegExp(`Select Local Test ${runId}`, 'i'),
    });
    await reviewerSelectOrg.waitFor({ state: 'visible' });
    await reviewerSelectOrg.click();
    await returningReviewerPage.waitForURL(
      (url) => url.pathname === organizationPath,
    );
    await audit(returningReviewerPage, 'returning evaluator organization view');
    const reviewerSessionRow = returningReviewerPage.locator(
      `li[data-session-id="${sessionId}"]`,
    );
    await reviewerSessionRow.waitFor({ state: 'visible' });
    const reviewerInspectLink = reviewerSessionRow.getByRole('link', {
      name: 'Inspect session',
    });
    await reviewerInspectLink.click();
    await returningReviewerPage.waitForURL((url) =>
      url.pathname.includes(`/sessions/${sessionId}`),
    );
    const returningWorkbenchLink = returningReviewerPage.getByTestId(
      'open-submitted-evidence-workbench-link',
    );
    await returningWorkbenchLink.waitFor({ state: 'visible' });
    await returningWorkbenchLink.click();
    await returningReviewerPage.waitForURL((url) =>
      url.pathname.startsWith('/r27/organizations/'),
    );
    await returningReviewerPage.getByRole('tab', { name: 'Review' }).click();
    await returningReviewerPage
      .getByTestId('review-packet-status')
      .filter({ hasText: 'FINALIZED' })
      .waitFor();
    await returningReviewerPage
      .getByTestId('review-packet-cited-observations')
      .getByText(observationText)
      .waitFor();
    await audit(returningReviewerPage, 'returning evaluator finalized review');
    const backToSession = returningReviewerPage.getByRole('link', {
      name: /Back to session summary/i,
    });
    await backToSession.waitFor({ state: 'visible' });
    await backToSession.click();
    await returningReviewerPage.waitForURL((url) =>
      url.pathname.includes(`/sessions/${sessionId}`),
    );
    const reviewerSignOut = returningReviewerPage.locator(
      'form[action="/r23/auth/logout"] button[type="submit"]',
    );
    await reviewerSignOut.waitFor({ state: 'visible' });
    await reviewerSignOut.click();
    await returningReviewerPage.waitForURL((url) => url.pathname === '/r23/login');

    assert.deepEqual(
      problems,
      [],
      'The journey produced browser console or runtime errors',
    );
    return {
      organizationId,
      sessionId,
      execution: `${executionStatus?.trim() ?? 'unknown'}; no execution or AI request was sent`,
      result: 'passed',
      screenshots,
    };
  } finally {
    await Promise.all(
      contexts.map((context) => context.close().catch(() => {})),
    );
    await browser.close().catch(() => {});
  }
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runFounderUatJourney()
    .then((result) => {
      console.log(
        `Founder UAT journey ${result.result}: org ${result.organizationId}, session ${result.sessionId}; execution ${result.execution}.`,
      );
      for (const path of result.screenshots) {
        console.log(`Local screenshot: ${path}`);
      }
    })
    .catch((error) => {
      console.error(
        error instanceof Error ? error.stack : 'Founder UAT journey failed.',
      );
      process.exitCode = 1;
    });
}
