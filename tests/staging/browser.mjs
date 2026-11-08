import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

export function stagingFailureSource(error) {
  if (typeof error?.stack !== 'string') return null;
  const sourceRoot = new URL('../../', import.meta.url).href;
  for (const line of error.stack.split('\n').slice(1)) {
    const frame = line.match(
      /^\s+at (?:[^()]* \()?(\S+\.mjs):([1-9]\d{0,5}):([1-9]\d{0,4})\)?$/,
    );
    if (!frame?.[1].startsWith(sourceRoot)) continue;
    const relativePath = frame[1].slice(sourceRoot.length);
    if (
      [
        'tests/staging/browser.mjs',
        'tests/staging/candidate-review-browser.mjs',
        'tests/staging/candidate-review-recovery.mjs',
        'tests/staging/security.mjs',
        'tests/staging/private-review.mjs',
        'tests/staging/journey.mjs',
        'tests/staging/release.mjs',
        'tests/staging/failure-source-check.mjs',
        'scripts/test-staging-integration.mjs',
      ].includes(relativePath)
    ) {
      return `${relativePath}:${frame[2]}:${frame[3]}`;
    }
  }
  return null;
}

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [process.env.R23_PLAYWRIGHT_MODULE, 'playwright'].filter(
    Boolean,
  );
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // try next candidate
    }
  }
  throw new Error('Unable to resolve Playwright module');
}

export async function readBrowserCsrf(context, appUrl) {
  // URL filtering omits Secure cookies on HTTP loopback even when Chromium accepts them.
  const hostname = new URL(appUrl).hostname;
  const cookie = (await context.cookies()).find(
    (value) =>
      value.name === '__Host-r23-csrf' &&
      value.domain === hostname &&
      value.path === '/' &&
      value.secure === true,
  );
  assert.ok(cookie, 'Browser CSRF cookie must be present for the app host');
  return cookie.value;
}

async function signInAndSelectOrganization(
  page,
  appUrl,
  user,
  organizationId,
  checkpoint = () => {},
) {
  const organization = organizationId.toLowerCase();
  checkpoint('Browser login page navigation');
  await page.goto(`${appUrl}/r23/login`);
  checkpoint('Browser login page load');
  await page.waitForLoadState('domcontentloaded');
  checkpoint('Browser recruiter email entry');
  await page.locator('input[name="email"]').fill(user.email);
  checkpoint('Browser recruiter password entry');
  await page.locator('input[name="password"]').fill(user.password);
  checkpoint('Browser recruiter login submit');
  await page.locator('button[type="submit"]').click();
  checkpoint('Browser organization list navigation');
  await page.waitForURL('**/r23/organizations');
  checkpoint('Browser organization list load');
  await page.waitForLoadState('domcontentloaded');

  const selectForm = page.locator('form').filter({
    has: page.locator(`input[value="${organization}"]`),
  });
  checkpoint('Browser authorized organization lookup');
  assert.ok(
    (await selectForm.count()) > 0,
    'Fresh recruiter login must include the authorized organization',
  );
  checkpoint('Browser organization selection submit');
  await selectForm.locator('button[type="submit"]').click();
  checkpoint('Browser selected organization navigation');
  await page.waitForURL(`**/r23/organizations/${organization}`);
  checkpoint('Browser selected organization load');
  await page.waitForLoadState('domcontentloaded');
}

async function withRecruiterPage(
  { appUrl, user, organizationId, checkpoint = () => {} },
  callback,
) {
  checkpoint('Playwright module resolution');
  const { chromium } = loadPlaywright();
  checkpoint('Chromium launch');
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.R23_CHROMIUM_PATH
      ? { executablePath: process.env.R23_CHROMIUM_PATH }
      : {}),
  });
  let context;
  try {
    checkpoint('Browser context creation');
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
    });
    checkpoint('Browser page creation');
    const page = await context.newPage();
    await signInAndSelectOrganization(
      page,
      appUrl,
      user,
      organizationId,
      checkpoint,
    );
    return await callback(page);
  } finally {
    await context?.close();
    await browser.close();
  }
}

async function readCandidateInvitationStatus(
  page,
  organizationId,
  sessionId,
  checkpoint = () => {},
  checkpointLabel = 'Candidate invitation status GET',
) {
  checkpoint(checkpointLabel);
  return page.evaluate(
    async ({ organization, session }) => {
      const response = await fetch(
        `/r23/api/organizations/${encodeURIComponent(organization)}/sessions/${encodeURIComponent(session)}/candidate-token`,
        { method: 'GET', cache: 'no-store' },
      );
      return { status: response.status, body: await response.json() };
    },
    { organization: organizationId, session: sessionId },
  );
}

function candidateInvitationFingerprint(candidatePath, expiresAt, sessionId) {
  if (
    typeof candidatePath !== 'string' ||
    !candidatePath.startsWith(`/r26/candidate/${sessionId}#`) ||
    typeof expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    throw new Error('Active candidate invitation response is incomplete');
  }
  return createHash('sha256')
    .update(candidatePath, 'utf8')
    .update('\0')
    .update(expiresAt, 'utf8')
    .digest('hex');
}

export async function createActiveCandidateInvitationFingerprint({
  appUrl,
  user,
  organizationId,
  sessionId,
  checkpoint = () => {},
}) {
  return withRecruiterPage(
    { appUrl, user, organizationId, checkpoint },
    async (page) => {
      const builderUrl =
        `${appUrl}/r23/organizations/${organizationId.toLowerCase()}/builder` +
        `?issuedSession=${encodeURIComponent(sessionId)}`;
      checkpoint('Candidate builder navigation');
      await page.goto(builderUrl);
      checkpoint('Candidate builder recovered-session wait');
      await page.getByTestId('recovered-session-id').waitFor({
        timeout: 20_000,
      });
      checkpoint('Candidate builder recovered-session verification');
      assert.equal(
        (await page.getByTestId('recovered-session-id').textContent()).trim(),
        sessionId,
        'Recovered issued session must match the active invitation fixture',
      );
      const invitationEndpoint = new URL(
        `/r23/api/organizations/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(sessionId)}/candidate-token`,
        appUrl,
      ).href;
      const invitationPost = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url() === invitationEndpoint,
        { timeout: 20_000 },
      );
      checkpoint('Candidate invitation create action');
      await page.getByTestId('candidate-invitation-create').click();
      checkpoint('Candidate invitation create response');
      const invitationResponse = await invitationPost;
      const invitationStatus = invitationResponse.status();
      const invitationResponseCategory =
        invitationStatus === 200 || invitationStatus === 201
          ? 'accepted'
          : invitationStatus === 400 || invitationStatus === 422
            ? 'validation'
            : invitationStatus === 401 || invitationStatus === 403
              ? 'authorization'
              : invitationStatus === 409
                ? 'conflict'
                : invitationStatus >= 500
                  ? 'server_error'
                  : 'unexpected';
      console.info(
        `Candidate invitation POST status=${invitationStatus} category=${invitationResponseCategory}`,
      );
      assert.ok(
        invitationStatus === 200 || invitationStatus === 201,
        `Candidate invitation POST returned HTTP ${invitationStatus} (${invitationResponseCategory})`,
      );
      checkpoint('Candidate invitation link wait');
      await page.getByTestId('candidate-invitation-link').waitFor({
        timeout: 20_000,
      });
      const result = await readCandidateInvitationStatus(
        page,
        organizationId,
        sessionId,
        checkpoint,
        'Candidate invitation status GET',
      );
      checkpoint('Candidate invitation status validation');
      assert.equal(result.status, 200, 'Invitation status GET must succeed');
      assert.equal(result.body?.sessionId, sessionId);
      assert.equal(result.body?.status, 'active');
      return candidateInvitationFingerprint(
        result.body?.candidatePath,
        result.body?.expiresAt,
        sessionId,
      );
    },
  );
}

export async function verifyCandidateInvitationRecovery({
  appUrl,
  user,
  organizationId,
  activeSessionId,
  revokedSessionId,
  expectedActiveFingerprint,
  checkpoint = () => {},
}) {
  return withRecruiterPage(
    { appUrl, user, organizationId, checkpoint },
    async (page) => {
      const builderBase = `${appUrl}/r23/organizations/${organizationId.toLowerCase()}/builder`;
      checkpoint('Active invitation recovery builder navigation');
      await page.goto(
        `${builderBase}?issuedSession=${encodeURIComponent(activeSessionId)}`,
      );
      checkpoint('Active invitation recovery builder wait');
      await page.getByTestId('recovered-session-id').waitFor({
        timeout: 20_000,
      });
      const activeResult = await readCandidateInvitationStatus(
        page,
        organizationId,
        activeSessionId,
        checkpoint,
        'Active invitation recovery status GET',
      );
      checkpoint('Active invitation recovery status validation');
      assert.equal(
        activeResult.status,
        200,
        'Invitation status GET must succeed',
      );
      assert.equal(activeResult.body?.sessionId, activeSessionId);
      assert.equal(activeResult.body?.status, 'active');
      const recoveredFingerprint = candidateInvitationFingerprint(
        activeResult.body?.candidatePath,
        activeResult.body?.expiresAt,
        activeSessionId,
      );
      if (recoveredFingerprint !== expectedActiveFingerprint) {
        throw new Error('Recovered active invitation fingerprint changed');
      }

      checkpoint('Revoked invitation recovery builder navigation');
      await page.goto(
        `${builderBase}?issuedSession=${encodeURIComponent(revokedSessionId)}`,
      );
      checkpoint('Revoked invitation recovery builder wait');
      await page.getByTestId('recovered-session-id').waitFor({
        timeout: 20_000,
      });
      const revokedResult = await readCandidateInvitationStatus(
        page,
        organizationId,
        revokedSessionId,
        checkpoint,
        'Revoked invitation recovery status GET',
      );
      checkpoint('Revoked invitation recovery status validation');
      assert.equal(
        revokedResult.status,
        200,
        'Invitation status GET must succeed',
      );
      assert.equal(revokedResult.body?.sessionId, revokedSessionId);
      assert.equal(revokedResult.body?.status, 'revoked');
      if (revokedResult.body?.candidatePath !== null) {
        throw new Error(
          'Recovered revoked invitation returned a candidate path',
        );
      }
      return true;
    },
  );
}

async function assertExpiredInvitationReplay({
  admin,
  page,
  context,
  appUrl,
  organizationId,
  sessionId,
  recruiterPrincipalId,
}) {
  const sessionRows = await admin.query(
    `SELECT organization_id::pg_catalog.text AS organization_id,
            issuer_principal_id::pg_catalog.text AS issuer_principal_id
       FROM hirearchy.assessment_sessions
      WHERE id = $1`,
    [sessionId],
  );
  assert.equal(sessionRows.rows.length, 1);
  const session = sessionRows.rows[0];
  assert.equal(session.organization_id, organizationId.toLowerCase());
  assert.equal(session.issuer_principal_id, recruiterPrincipalId);
  const existingEnvelope = await admin.query(
    'SELECT 1 FROM hirearchy.candidate_token_envelopes WHERE session_id = $1',
    [sessionId],
  );
  assert.equal(existingEnvelope.rows.length, 0);

  const idempotencyKey = `expired-replay.${randomUUID()}`;
  const expiresAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const createdAt = new Date(Date.parse(expiresAt) - 24 * 60 * 60 * 1000);
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify({
        expiresAt,
        organizationId: session.organization_id,
        sessionId,
      }),
      'utf8',
    )
    .digest('hex');
  const tokenHash = randomBytes(32).toString('hex');
  await admin.query(
    `INSERT INTO hirearchy.candidate_token_envelopes (
       organization_id, session_id, candidate_token_hash,
       candidate_token_ciphertext, created_at, expires_at
     ) VALUES (
       $1::pg_catalog.uuid, $2, $3, 'synthetic-expired-envelope',
       $4::pg_catalog.timestamptz, $5::pg_catalog.timestamptz
     )`,
    [session.organization_id, sessionId, tokenHash, createdAt, expiresAt],
  );
  await admin.query(
    `INSERT INTO hirearchy.candidate_invitation_requests (
       organization_id, idempotency_key, session_id, issuer_principal_id,
       request_hash, expires_at
     ) VALUES ($1::pg_catalog.uuid, $2, $3, $4::pg_catalog.uuid, $5, $6::pg_catalog.timestamptz)`,
    [
      session.organization_id,
      idempotencyKey,
      sessionId,
      session.issuer_principal_id,
      requestHash,
      expiresAt,
    ],
  );

  const csrf = await readBrowserCsrf(context, appUrl);
  const result = await page.evaluate(
    async ({
      organizationId: orgId,
      sessionId: issuedSessionId,
      csrf,
      idempotencyKey,
      expiresAt,
    }) => {
      const response = await fetch(
        `/r23/api/organizations/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(issuedSessionId)}/candidate-token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
            'X-CSRF-Token': csrf,
          },
          body: JSON.stringify({ csrf, expiresAt }),
          cache: 'no-store',
        },
      );
      return { status: response.status, body: await response.json() };
    },
    { organizationId, sessionId, csrf, idempotencyKey, expiresAt },
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    sessionId,
    status: 'expired',
    expiresAt,
    candidatePath: null,
  });
}

async function reviewWriteCounts(admin, organizationId, sessionId) {
  const { rows } = await admin.query(
    `SELECT
       (SELECT pg_catalog.count(*)::pg_catalog.int4
          FROM hirearchy.evaluator_observations
         WHERE organization_id = $1::pg_catalog.uuid AND session_id = $2) AS observations,
       (SELECT pg_catalog.count(*)::pg_catalog.int4
          FROM hirearchy.evaluator_observation_history
         WHERE organization_id = $1::pg_catalog.uuid AND session_id = $2) AS observation_history,
       (SELECT pg_catalog.count(*)::pg_catalog.int4
          FROM hirearchy.evaluator_review_packets
         WHERE organization_id = $1::pg_catalog.uuid AND session_id = $2) AS review_packets,
       (SELECT pg_catalog.count(*)::pg_catalog.int4
          FROM hirearchy.evaluator_review_packet_history
         WHERE organization_id = $1::pg_catalog.uuid AND session_id = $2) AS review_packet_history`,
    [organizationId, sessionId],
  );
  return rows[0];
}

async function assertUnassignedReviewerWritesDenied({
  browser,
  appUrl,
  user,
  organizationId,
  sessionId,
  admin,
}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await page.goto(`${appUrl}/r23/login`);
    await page.locator('input[name="email"]').fill(user.email);
    await page.locator('input[name="password"]').fill(user.password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/r23/organizations');
    const selectForm = page.locator('form').filter({
      has: page.locator(`input[value="${organizationId.toLowerCase()}"]`),
    });
    await selectForm.locator('button[type="submit"]').click();
    await page.waitForURL(
      `**/r23/organizations/${organizationId.toLowerCase()}`,
    );

    const csrf = await readBrowserCsrf(context, appUrl);
    const before = await reviewWriteCounts(admin, organizationId, sessionId);
    const basePath = `/r27/api/organizations/${encodeURIComponent(organizationId.toLowerCase())}/sessions/${encodeURIComponent(sessionId)}`;
    const observationStatus = await page.evaluate(
      async ({ basePath, csrf }) => {
        const response = await fetch(`${basePath}/observations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
          },
          body: JSON.stringify({
            csrf,
            evidenceSourceType: 'timeline_event',
            eventSequence: '1',
            evidenceDigest: '0'.repeat(64),
            body: 'Unassigned reviewer write must be rejected.',
          }),
        });
        return response.status;
      },
      { basePath, csrf },
    );
    assert.equal(observationStatus, 403);

    const packetStatus = await page.evaluate(
      async ({ basePath, csrf }) => {
        const response = await fetch(`${basePath}/review-packet`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
          },
          body: JSON.stringify({
            csrf,
            summary: 'Unassigned reviewer write must be rejected.',
            strengths: [],
            concerns: [],
            unresolvedQuestions: [],
            referencedObservationIds: [],
            referencedEvidence: [],
          }),
        });
        return response.status;
      },
      { basePath, csrf },
    );
    assert.equal(packetStatus, 403);
    assert.deepEqual(
      await reviewWriteCounts(admin, organizationId, sessionId),
      before,
      'Denied unassigned reviewer writes must not change observations, review packets, or history',
    );
  } finally {
    await context.close();
  }
}

/**
 * End-to-end browser acceptance suite verifying R2.15 authenticated staging workflow
 * against real Chromium browser, GoTrue auth, PostgreSQL proofs, and Next.js server.
 */
export async function checkBrowserAcceptance({
  appUrl: initialAppUrl,
  users,
  organizationId,
  provisioned,
  stopApp,
  startApp,
  admin,
  source,
  authUrl,
  submittedSessionId,
  browserEvidenceDir,
  screenshotSensitiveValues,
}) {
  let appUrl = initialAppUrl;
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.R23_CHROMIUM_PATH
      ? { executablePath: process.env.R23_CHROMIUM_PATH }
      : {}),
  });

  const recruiterUser = users[0];
  const reviewerUser = users[1];
  const otherReviewerUser = users[2];

  let newlyIssuedSessionId = null;

  try {
    // -------------------------------------------------------------------------
    // Phase 1: Incorrect and Correct Browser Sign-in
    // -------------------------------------------------------------------------
    console.log('Browser Acceptance [1/8]: Testing incorrect sign-in...');
    {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();

      await page.goto(`${appUrl}/r23/login`);
      await page.waitForLoadState('domcontentloaded');

      // Verify sign in form fields
      assert.ok(await page.locator('input[name="email"]').isVisible());
      assert.ok(await page.locator('input[name="password"]').isVisible());

      // Attempt login with invalid password
      await page.locator('input[name="email"]').fill(recruiterUser.email);
      await page.locator('input[name="password"]').fill('incorrect-password');
      await Promise.all([
        page.waitForResponse((res) => res.url().includes('/r23/auth/login')),
        page.locator('button[type="submit"]').click(),
      ]);
      await page.waitForLoadState('domcontentloaded');

      // Verify failure alert is shown and user remains on /r23/login or /r23/auth/login
      const currentUrl = page.url();
      const pageText = await page.textContent('body');
      assert.ok(
        pageText.includes('Invalid') ||
          pageText.includes('Authentication failed') ||
          pageText.includes('Sign in'),
        'Failure message or login prompt must be rendered',
      );

      await context.close();
    }

    console.log(
      'Browser Acceptance [2/8]: Testing valid recruiter sign-in and cookie security...',
    );
    const recruiterContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
    });
    const recruiterPage = await recruiterContext.newPage();
    {
      await recruiterPage.goto(`${appUrl}/r23/login`);
      await recruiterPage.waitForLoadState('domcontentloaded');

      await recruiterPage
        .locator('input[name="email"]')
        .fill(recruiterUser.email);
      await recruiterPage
        .locator('input[name="password"]')
        .fill(recruiterUser.password);
      await recruiterPage.locator('button[type="submit"]').click();
      await recruiterPage.waitForURL('**/r23/organizations');
      await recruiterPage.waitForLoadState('domcontentloaded');

      // Verify secure HTTP-only cookies
      const cookies = await recruiterContext.cookies();
      const sessionCookie = cookies.find(
        (c) => c.name === '__Host-r23-session' || c.name.includes('session'),
      );
      assert.ok(sessionCookie, 'Session cookie must be set');
      assert.equal(
        sessionCookie.httpOnly,
        true,
        'Session cookie must be HttpOnly',
      );
      assert.equal(sessionCookie.secure, true, 'Session cookie must be Secure');
      assert.equal(
        sessionCookie.sameSite,
        'Strict',
        'Session cookie must be SameSite=Strict',
      );

      // Verify browser storage isolation (no session tokens in document.cookie or localStorage)
      const docCookie = await recruiterPage.evaluate(() => document.cookie);
      assert.doesNotMatch(
        docCookie,
        /session/i,
        'Raw session cookie must not be accessible via document.cookie',
      );
      const storageCount = await recruiterPage.evaluate(
        () => localStorage.length + sessionStorage.length,
      );
      assert.equal(
        storageCount,
        0,
        'Storage must not retain credentials or session keys',
      );
    }

    // -------------------------------------------------------------------------
    // Phase 2: Organization Selection & Isolation
    // -------------------------------------------------------------------------
    console.log(
      'Browser Acceptance [3/8]: Testing organization selection and isolation...',
    );
    {
      const orgsText = await recruiterPage.textContent('body');
      assert.ok(
        orgsText.includes(organizationId.toLowerCase()),
        'Organization list must include authorized organization',
      );

      // Select authorized organization
      const selectForm = recruiterPage.locator('form').filter({
        has: recruiterPage.locator(
          `input[value="${organizationId.toLowerCase()}"]`,
        ),
      });
      await selectForm.locator('button[type="submit"]').click();
      await recruiterPage.waitForURL(
        `**/r23/organizations/${organizationId.toLowerCase()}`,
      );
      await recruiterPage.waitForLoadState('domcontentloaded');

      const workspaceText = await recruiterPage.textContent('body');
      assert.ok(
        workspaceText.includes(
          'Recruiter scope: sessions issued by your account',
        ),
        'Recruiter scope banner must be displayed',
      );
      assert.ok(
        workspaceText.includes(organizationId.toLowerCase()),
        'Current organization ID must be displayed',
      );

      // Verify staging capabilities boundary notice
      const capabilityNotice = recruiterPage.locator(
        '[data-testid="staging-workspace-capability-notice"]',
      );
      assert.ok(
        await capabilityNotice.isVisible(),
        'Staging workspace capabilities notice must be visible',
      );

      // Verify cross-organization access rejection
      const foreignOrgId = randomUUID();
      const foreignRes = await recruiterPage.goto(
        `${appUrl}/r23/organizations/${foreignOrgId}`,
      );
      assert.equal(
        foreignRes.status(),
        403,
        'Accessing unauthorized foreign organization must return 403',
      );
      const foreignBody = await recruiterPage.textContent('body');
      assert.ok(
        !foreignBody.includes('Current organization:'),
        'Foreign organization content must not be displayed',
      );

      // Navigate back to authorized organization workspace
      await recruiterPage.goto(
        `${appUrl}/r23/organizations/${organizationId.toLowerCase()}`,
      );
      await recruiterPage.waitForLoadState('domcontentloaded');
    }

    // -------------------------------------------------------------------------
    // Phase 3: Recruiter Assessment Authoring, Static Validation & Issuance
    // -------------------------------------------------------------------------
    console.log(
      'Browser Acceptance [4/8]: Testing recruiter draft authoring, static validation and issuance...',
    );
    {
      // Navigate to assessment builder
      const builderRes = await recruiterPage.goto(
        `${appUrl}/r23/organizations/${organizationId.toLowerCase()}/builder`,
      );
      await recruiterPage.waitForLoadState('domcontentloaded');
      assert.equal(
        builderRes?.status(),
        200,
        'Recruiter must be able to load builder page',
      );
      await recruiterPage.waitForSelector(
        '[data-testid="builder-staging-capabilities-banner"]',
        { timeout: 15000 },
      );

      // Stage 1: Brief & Starter Files
      await recruiterPage
        .locator('[data-testid="assessment-title-input"]')
        .fill('Browser Staging Verified Assessment');
      await recruiterPage
        .locator('[data-testid="assessment-brief-input"]')
        .fill(
          'Implement durable retry logic in Python for notifications with observable attempt history.',
        );
      await recruiterPage
        .locator('[data-testid="primary-file-path-input"]')
        .fill('src/service.py');

      // Save draft
      await recruiterPage.locator('[data-testid="save-draft-button"]').click();
      await recruiterPage.waitForSelector(
        '[data-testid="draft-status"]:has-text("Saved")',
      );

      // Continue to stage 2: Validate
      await recruiterPage
        .locator('[data-testid="continue-to-validate-button"]')
        .click();

      // Trigger static validation
      await recruiterPage
        .locator('[data-testid="validate-assessment-button"]')
        .click();
      await recruiterPage.waitForSelector(
        '[data-testid="validated-version-display"]',
      );

      // Verify execution notice (explaining execution validation is disabled and static was used)
      const executionNotice = recruiterPage.locator(
        '[data-testid="execution-notice"]',
      );
      assert.ok(
        await executionNotice.isVisible(),
        'Execution limitation notice must be visible on validation',
      );
      const digestBadge = recruiterPage.locator(
        '[data-testid="content-digest-badge"]',
      );
      assert.ok(
        await digestBadge.isVisible(),
        'Content digest badge must be visible',
      );
      const digestText = await digestBadge.textContent();
      assert.match(
        digestText,
        /sha256:/i,
        'Content digest badge must display SHA-256',
      );

      // Continue to stage 3: Issue
      await recruiterPage
        .locator('[data-testid="continue-to-issue-button"]')
        .click();

      // Select reviewer from dropdown
      const reviewerSelect = recruiterPage.locator(
        '[data-testid="issue-reviewer-select"]',
      );
      assert.ok(
        await reviewerSelect.isVisible(),
        'Reviewer selector must be visible',
      );
      await reviewerSelect.selectOption(provisioned.users[1].principalId);

      // Issue assessment
      await recruiterPage
        .locator('[data-testid="issue-assessment-button"]')
        .click();
      await recruiterPage.waitForSelector('[data-testid="issuance-success"]');

      // Candidate links are created only through the explicit invitation panel.
      const candidateInvitationPanel = recruiterPage.locator(
        '[data-testid="candidate-invitation-panel"]',
      );
      assert.ok(
        await candidateInvitationPanel.isVisible(),
        'Candidate invitation controls must be visible after authenticated issuance',
      );

      newlyIssuedSessionId = (
        await recruiterPage
          .locator('[data-testid="issued-session-id"]')
          .textContent()
      ).trim();
      assert.match(
        newlyIssuedSessionId,
        /^sess_[0-9a-f-]{36}$/i,
        'Issued session ID must match sess_UUID',
      );
      assert.equal(
        new URL(recruiterPage.url()).searchParams.get('issuedSession'),
        newlyIssuedSessionId,
        'Issuing an assessment must retain its non-secret session ID in the builder URL',
      );

      assert.ok(
        submittedSessionId,
        'A submitted session is required for the expired invitation replay check',
      );
      await assertExpiredInvitationReplay({
        admin,
        page: recruiterPage,
        context: recruiterContext,
        appUrl,
        organizationId,
        sessionId: submittedSessionId,
        recruiterPrincipalId: provisioned.users[0].principalId,
      });

      const summaryRes = await recruiterPage.goto(
        `${appUrl}/r23/organizations/${organizationId.toLowerCase()}/sessions/${newlyIssuedSessionId}`,
      );
      assert.equal(summaryRes.status(), 200);
      const manageInvitationLink = recruiterPage.locator(
        '[data-testid="manage-candidate-invitation-link"]',
      );
      assert.ok(await manageInvitationLink.isVisible());
      assert.equal(
        await manageInvitationLink.getAttribute('href'),
        `/r23/organizations/${organizationId.toLowerCase()}/builder?issuedSession=${encodeURIComponent(newlyIssuedSessionId)}`,
      );

      // Return to session list and verify newly issued session is displayed
      await recruiterPage.goto(
        `${appUrl}/r23/organizations/${organizationId.toLowerCase()}`,
      );
      await recruiterPage.waitForLoadState('domcontentloaded');
      const refreshedList = await recruiterPage.textContent('body');
      assert.ok(
        refreshedList.includes(newlyIssuedSessionId),
        `Newly issued session ${newlyIssuedSessionId} must appear in recruiter session list`,
      );
    }

    // -------------------------------------------------------------------------
    // Phase 4: Role Separation & Evaluator Access
    // -------------------------------------------------------------------------
    console.log(
      'Browser Acceptance [5/8]: Testing role separation and evaluator access...',
    );
    {
      // Recruiter attempts to access reviewer evidence page -> 403 Forbidden or 404 Not Found
      const recruiterEvRes = await recruiterPage.goto(
        `${appUrl}/r27/organizations/${organizationId.toLowerCase()}/sessions/${newlyIssuedSessionId}`,
      );
      assert.ok(
        recruiterEvRes.status() === 403 || recruiterEvRes.status() === 404,
        `Recruiter must be denied access to evaluator evidence route (got ${recruiterEvRes.status()})`,
      );

      // Reviewer 1 (assigned reviewer) signs in
      const reviewerContext = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 900 },
      });
      const reviewerPage = await reviewerContext.newPage();

      await reviewerPage.goto(`${appUrl}/r23/login`);
      await reviewerPage.waitForLoadState('domcontentloaded');
      await reviewerPage
        .locator('input[name="email"]')
        .fill(reviewerUser.email);
      await reviewerPage
        .locator('input[name="password"]')
        .fill(reviewerUser.password);
      await reviewerPage.locator('button[type="submit"]').click();
      await reviewerPage.waitForURL('**/r23/organizations');
      await reviewerPage.waitForLoadState('domcontentloaded');

      // Reviewer 1 selects organization
      const selectForm = reviewerPage.locator('form').filter({
        has: reviewerPage.locator(
          `input[value="${organizationId.toLowerCase()}"]`,
        ),
      });
      await selectForm.locator('button[type="submit"]').click();
      await reviewerPage.waitForURL(
        `**/r23/organizations/${organizationId.toLowerCase()}`,
      );
      await reviewerPage.waitForLoadState('domcontentloaded');

      const revBody = await reviewerPage.textContent('body');
      assert.ok(
        revBody.includes(
          'Reviewer scope: sessions actively assigned to your evaluator account',
        ),
        'Reviewer scope banner must be displayed',
      );

      // Reviewer attempts to access recruiter builder -> 403 Forbidden or 404 Not Found
      const revBuilderRes = await reviewerPage.goto(
        `${appUrl}/r23/organizations/${organizationId.toLowerCase()}/builder`,
      );
      assert.ok(
        revBuilderRes.status() === 403 || revBuilderRes.status() === 404,
        `Reviewer must be denied access to assessment builder (got ${revBuilderRes.status()})`,
      );

      // Assigned reviewer views session summary (/r23/.../sessions/[sessionId]) -> 200 OK
      const summaryRes = await reviewerPage.goto(
        `${appUrl}/r23/organizations/${organizationId.toLowerCase()}/sessions/${newlyIssuedSessionId}`,
      );
      assert.equal(
        summaryRes.status(),
        200,
        'Assigned reviewer must access session summary',
      );
      const summaryText = await reviewerPage.textContent('body');
      assert.ok(
        summaryText.includes('CREATED') || summaryText.includes('Issued'),
        'Session status CREATED or Issued must be visible',
      );
      assert.ok(
        summaryText.includes(
          'Candidate invitation links are managed by the issuing recruiter.',
        ),
        'Assigned reviewer must see that candidate invitation access is recruiter-managed',
      );
      assert.ok(
        summaryText.includes(provisioned.users[1].principalId),
        'Assigned reviewer principal ID must be visible',
      );

      // Assigned reviewer views evidence route (/r27/.../sessions/[sessionId])
      // Since status is CREATED (unsubmitted), verify explicit unsubmitted-evidence-unavailable notice
      const evidenceRes = await reviewerPage.goto(
        `${appUrl}/r27/organizations/${organizationId.toLowerCase()}/sessions/${newlyIssuedSessionId}`,
      );
      assert.equal(
        evidenceRes.status(),
        200,
        'Assigned reviewer accesses unsubmitted evidence page',
      );
      const unsubmittedNotice = reviewerPage.locator(
        '[data-testid="unsubmitted-evidence-unavailable"]',
      );
      assert.ok(
        await unsubmittedNotice.isVisible(),
        'Unsubmitted evidence unavailable notice must be visible for CREATED session',
      );
      const unsubmittedText = await reviewerPage.textContent('body');
      assert.ok(
        unsubmittedText.includes('Browser Staging Verified Assessment'),
        'Permitted assessment title must be visible',
      );

      // Other reviewer (unassigned reviewer) attempts access -> 403 Forbidden
      const otherReviewerContext = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 900 },
      });
      const otherReviewerPage = await otherReviewerContext.newPage();

      await otherReviewerPage.goto(`${appUrl}/r23/login`);
      await otherReviewerPage.waitForLoadState('domcontentloaded');
      await otherReviewerPage
        .locator('input[name="email"]')
        .fill(otherReviewerUser.email);
      await otherReviewerPage
        .locator('input[name="password"]')
        .fill(otherReviewerUser.password);
      await otherReviewerPage.locator('button[type="submit"]').click();
      await otherReviewerPage.waitForURL('**/r23/organizations');
      await otherReviewerPage.waitForLoadState('domcontentloaded');

      const otherSelect = otherReviewerPage.locator('form').filter({
        has: otherReviewerPage.locator(
          `input[value="${organizationId.toLowerCase()}"]`,
        ),
      });
      await otherSelect.locator('button[type="submit"]').click();
      await otherReviewerPage.waitForURL(
        `**/r23/organizations/${organizationId.toLowerCase()}`,
      );
      await otherReviewerPage.waitForLoadState('domcontentloaded');

      // Unassigned reviewer visits session summary -> 403 Forbidden or 404 Not Found
      const otherSummaryRes = await otherReviewerPage.goto(
        `${appUrl}/r23/organizations/${organizationId.toLowerCase()}/sessions/${newlyIssuedSessionId}`,
      );
      assert.ok(
        otherSummaryRes.status() === 403 || otherSummaryRes.status() === 404,
        `Unassigned reviewer must be denied session summary (got ${otherSummaryRes.status()})`,
      );

      // Unassigned reviewer visits evidence workbench -> 403 Forbidden or 404 Not Found
      const otherEvidenceRes = await otherReviewerPage.goto(
        `${appUrl}/r27/organizations/${organizationId.toLowerCase()}/sessions/${newlyIssuedSessionId}`,
      );
      assert.ok(
        otherEvidenceRes.status() === 403 || otherEvidenceRes.status() === 404,
        `Unassigned reviewer must be denied evidence access (got ${otherEvidenceRes.status()})`,
      );

      await otherReviewerContext.close();
      await reviewerContext.close();
    }

    // -------------------------------------------------------------------------
    // Phase 5: Private Reviewer Data Isolation on SUBMITTED Session
    // -------------------------------------------------------------------------
    if (submittedSessionId) {
      console.log(
        'Browser Acceptance [6/8]: Testing private reviewer data isolation on SUBMITTED session...',
      );

      const recruiterSubmittedSummary = await recruiterPage.goto(
        `${appUrl}/r23/organizations/${organizationId.toLowerCase()}/sessions/${submittedSessionId}`,
      );
      assert.equal(
        recruiterSubmittedSummary.status(),
        200,
        'Recruiter must retain access to the issued session summary after submission',
      );
      const recruiterSubmittedSummaryText =
        await recruiterPage.textContent('body');
      assert.ok(
        recruiterSubmittedSummaryText.includes(
          'This session has been submitted. Submitted evidence and reviewer notes are available only to the reviewer assigned to this session.',
        ),
        'Submitted non-reviewer must see the assigned-reviewer access scope',
      );

      // Reviewer 1 visits submitted session
      const rev1Context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 900 },
      });
      const rev1Page = await rev1Context.newPage();
      await rev1Page.goto(`${appUrl}/r23/login`);
      await rev1Page.locator('input[name="email"]').fill(reviewerUser.email);
      await rev1Page
        .locator('input[name="password"]')
        .fill(reviewerUser.password);
      await rev1Page.locator('button[type="submit"]').click();
      await rev1Page.waitForURL('**/r23/organizations');

      const select1 = rev1Page.locator('form').filter({
        has: rev1Page.locator(`input[value="${organizationId.toLowerCase()}"]`),
      });
      await select1.locator('button[type="submit"]').click();
      await rev1Page.waitForURL(
        `**/r23/organizations/${organizationId.toLowerCase()}`,
      );

      const rev1EvRes = await rev1Page.goto(
        `${appUrl}/r27/organizations/${organizationId.toLowerCase()}/sessions/${submittedSessionId}`,
      );
      assert.equal(rev1EvRes.status(), 200);
      await rev1Page.waitForLoadState('domcontentloaded');

      // Switch to Review tab and verify the assigned reviewer can author a draft.
      await rev1Page
        .locator('button[data-workbench-mode-tab="review"]')
        .click();
      await rev1Page
        .getByRole('textbox', { name: 'Review summary' })
        .waitFor({ timeout: 15000 });

      // Verify Reviewer 1 private data is visible and Reviewer 2 private data is absent
      const rev1Text = await rev1Page.textContent('body');
      assert.ok(
        rev1Text.includes(`private-${provisioned.users[1].principalId}`),
        'Reviewer 1 private observation/packet text must be present for Reviewer 1',
      );
      assert.ok(
        !rev1Text.includes(`private-${provisioned.users[2].principalId}`),
        'Reviewer 2 private observation/packet text must NOT be present for Reviewer 1',
      );

      // Switch to Evidence tab and verify the assigned reviewer can author notes.
      await rev1Page
        .locator('button[data-workbench-mode-tab="evidence"]')
        .click();
      await rev1Page.waitForLoadState('domcontentloaded');

      // Select timeline event in source list to view anchored observation panel
      const eventRow = rev1Page.locator(
        'button.evaluator-source-row:has-text("Session submitted")',
      );
      if (await eventRow.isVisible()) {
        await eventRow.click();
      }

      await rev1Page
        .getByRole('textbox', { name: 'Observation note' })
        .waitFor({ timeout: 15000 });

      // Reviewer 2 visits submitted session
      const rev2Context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 900 },
      });
      const rev2Page = await rev2Context.newPage();
      await rev2Page.goto(`${appUrl}/r23/login`);
      await rev2Page
        .locator('input[name="email"]')
        .fill(otherReviewerUser.email);
      await rev2Page
        .locator('input[name="password"]')
        .fill(otherReviewerUser.password);
      await rev2Page.locator('button[type="submit"]').click();
      await rev2Page.waitForURL('**/r23/organizations');

      const select2 = rev2Page.locator('form').filter({
        has: rev2Page.locator(`input[value="${organizationId.toLowerCase()}"]`),
      });
      await select2.locator('button[type="submit"]').click();
      await rev2Page.waitForURL(
        `**/r23/organizations/${organizationId.toLowerCase()}`,
      );

      const rev2EvRes = await rev2Page.goto(
        `${appUrl}/r27/organizations/${organizationId.toLowerCase()}/sessions/${submittedSessionId}`,
      );
      assert.equal(rev2EvRes.status(), 200);
      await rev2Page.waitForLoadState('domcontentloaded');

      // Switch to Review tab for Reviewer 2
      await rev2Page
        .locator('button[data-workbench-mode-tab="review"]')
        .click();
      await rev2Page
        .getByRole('textbox', { name: 'Review summary' })
        .waitFor({ timeout: 15000 });

      const rev2Text = await rev2Page.textContent('body');
      assert.ok(
        rev2Text.includes(`private-${provisioned.users[2].principalId}`),
        'Reviewer 2 private observation/packet text must be present for Reviewer 2',
      );
      assert.ok(
        !rev2Text.includes(`private-${provisioned.users[1].principalId}`),
        'Reviewer 1 private observation/packet text must NOT be present for Reviewer 2',
      );

      await rev1Context.close();
      await rev2Context.close();
    }

    // -------------------------------------------------------------------------
    // Phase 6: Application Restart & Browser Session Recovery
    // -------------------------------------------------------------------------
    console.log(
      'Browser Acceptance [7/8]: Testing server restart and session recovery...',
    );
    {
      // Recruiter page is still open in recruiterContext with active cookie
      await stopApp();
      appUrl = await startApp(source, authUrl);

      // In the same browser context, reload the workspace
      const restartedRes = await recruiterPage.goto(
        `${appUrl}/r23/organizations/${organizationId.toLowerCase()}`,
      );
      assert.equal(
        restartedRes.status(),
        200,
        'Recruiter browser session must persist across application restart',
      );
      const restartedBody = await recruiterPage.textContent('body');
      assert.ok(
        restartedBody.includes(organizationId.toLowerCase()),
        'Session state and authorized organization remain active without re-login',
      );
    }

    // -------------------------------------------------------------------------
    // Phase 7: Sign-out, Revocation & Blocked Routes
    // -------------------------------------------------------------------------
    console.log(
      'Browser Acceptance [8/8]: Testing sign-out, membership revocation and blocked routes...',
    );
    {
      // Sign out
      const logoutForm = recruiterPage.locator(
        'form[action="/r23/auth/logout"]',
      );
      await logoutForm.locator('button[type="submit"]').click();
      await recruiterPage.waitForURL('**/r23/login');
      await recruiterPage.waitForLoadState('domcontentloaded');

      // Attempting to access workspace after sign out redirects to login or is denied with 401
      const afterLogoutRes = await recruiterPage.goto(
        `${appUrl}/r23/organizations/${organizationId.toLowerCase()}`,
      );
      assert.ok(
        recruiterPage.url().includes('/r23/login') ||
          afterLogoutRes.status() === 401,
        'Visiting workspace after sign-out must redirect to login or return 401 Unauthorized',
      );
      if (afterLogoutRes.status() === 401) {
        const afterLogoutBody = await recruiterPage.textContent('body');
        assert.ok(
          afterLogoutBody.includes('Sign in') ||
            afterLogoutBody.includes('denied'),
          'Sign in link or denial notice must be present when unauthenticated',
        );
      }

      // Verify blocked legacy, execution, and AI routes return 503
      const blockedRoutes = [
        ['GET', '/evaluator'],
        ['POST', '/api/evaluator/assessments/generate'],
        ['POST', '/api/evaluator/assessments/preview'],
        ['POST', '/api/evaluator/assessments'],
        ['POST', `/r26/api/candidate/${newlyIssuedSessionId}/execution`],
        ['POST', `/r26/api/candidate/${newlyIssuedSessionId}/ai`],
      ];

      for (const [method, path] of blockedRoutes) {
        const response = await fetch(`${appUrl}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: method === 'POST' ? JSON.stringify({}) : undefined,
        });
        assert.equal(
          response.status,
          503,
          `Blocked route ${method} ${path} must return 503 STAGING_CAPABILITY_DISABLED`,
        );
        const data = await response.json();
        assert.equal(
          data.error?.code,
          'STAGING_CAPABILITY_DISABLED',
          `Blocked route ${path} error code must be STAGING_CAPABILITY_DISABLED`,
        );
      }

      await recruiterContext.close();
    }

    console.log(
      'Browser Acceptance [9/9]: Testing durable candidate and assigned-reviewer workflow...',
    );
    const { checkCandidateReviewBrowserAcceptance } =
      await import('./candidate-review-browser.mjs');
    let restartedAppUrl = null;
    const captureStartApp = async (...args) => {
      restartedAppUrl = await startApp(...args);
      return restartedAppUrl;
    };
    const candidateReview = await checkCandidateReviewBrowserAcceptance({
      appUrl,
      browserEvidenceDir,
      users,
      organizationId,
      sessionId: newlyIssuedSessionId,
      stopApp,
      startApp: captureStartApp,
      source,
      authUrl,
      screenshotSensitiveValues,
    });
    assert.equal(candidateReview.passed, true);
    appUrl =
      typeof candidateReview.appUrl === 'string'
        ? candidateReview.appUrl
        : (restartedAppUrl ?? appUrl);
    const reviewedSessionId = candidateReview.sessionId ?? newlyIssuedSessionId;
    assert.equal(reviewedSessionId, newlyIssuedSessionId);
    await assertUnassignedReviewerWritesDenied({
      browser,
      appUrl,
      user: otherReviewerUser,
      organizationId,
      sessionId: reviewedSessionId,
      admin,
    });

    console.log('✓ All browser acceptance checks passed successfully.');
    return {
      passed: true,
      newlyIssuedSessionId,
      reviewedSessionId,
      appUrl,
    };
  } finally {
    await browser.close();
  }
}
