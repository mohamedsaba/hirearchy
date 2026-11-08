import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { FIXTURE_IDS } from '../../database/postgres/r23/adapter.mjs';
import { loadPlaywright } from '../r25/browser-issuance-check.mjs';

const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core/axe.min.js');
const axeSource = readFileSync(axePath, 'utf8');

const SCREENSHOT_DIR = '/tmp/hirearchy-ux-screenshots';
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};

export async function runDemoUxAcceptanceWalkthrough({
  origin,
  users,
  admin,
}) {
  const auditReport = {
    steps: [],
    overflows: [],
    axeViolations: [],
    pageErrors: [],
    consoleErrors: [],
  };

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-network-change-notifier',
    ],
  });

  const recordConsole = (label, msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (
        text.includes('ERR_CONNECTION_REFUSED') ||
        text.includes('[HMR]') ||
        text.includes('status of 403') ||
        text.includes('status of 404')
      ) {
        return;
      }
      auditReport.consoleErrors.push(`[${label}] ${text}`);
    }
  };

  async function auditAndCapture(page, stepNum, stepName, label) {
    const stepKey = `step${String(stepNum).padStart(2, '0')}-${stepName}`;
    console.log(`\n>>> [Step ${stepNum}] ${label}`);

    for (const [vpName, dims] of Object.entries(VIEWPORTS)) {
      await page.setViewportSize(dims);
      await page.waitForLoadState('load');
      await page.waitForTimeout(300);
      await page.evaluate(() => document.fonts?.ready).catch(() => {});

      // Horizontal overflow check
      const overflow = await page.evaluate(() => {
        const docWidth = Math.max(
          document.documentElement.scrollWidth,
          document.body?.scrollWidth ?? 0,
        );
        const clientWidth = document.documentElement.clientWidth;
        return {
          docWidth,
          clientWidth,
          hasOverflow: docWidth > clientWidth + 1,
        };
      });

      if (overflow.hasOverflow) {
        auditReport.overflows.push({
          step: stepKey,
          viewport: vpName,
          docWidth: overflow.docWidth,
          clientWidth: overflow.clientWidth,
        });
        const badElements = await page.evaluate(() => {
          const cw = document.documentElement.clientWidth;
          const offenders = [];
          for (const el of document.querySelectorAll('*')) {
            if (el.scrollWidth > cw + 1 || el.clientWidth > cw + 1) {
              offenders.push(`${el.tagName}.${el.className} [scrollWidth=${el.scrollWidth}]`);
            }
          }
          return offenders.slice(-8);
        }).catch(() => []);
        console.warn(
          `  ⚠️ Overflow on ${vpName}: scrollWidth=${overflow.docWidth}px > clientWidth=${overflow.clientWidth}px`,
          badElements,
        );
      }

      // Accessibility audit with axe (on desktop)
      let violations = [];
      if (vpName === 'desktop') {
        try {
          await page.addScriptTag({ content: axeSource });
          violations = await page.evaluate(async () => {
            const res = await window.axe.run(document, {
              runOnly: {
                type: 'tag',
                values: ['wcag2a', 'wcag2aa', 'wcag21aa'],
              },
            });
            return res.violations.map((v) => ({
              id: v.id,
              impact: v.impact,
              description: v.description,
              nodes: v.nodes.length,
              targets: v.nodes.slice(0, 3).map((n) => n.target),
            }));
          });
          if (violations.length > 0) {
            auditReport.axeViolations.push({
              step: stepKey,
              violations,
            });
            for (const v of violations) {
              console.warn(
                `  ⚠️ Axe [${v.impact}] ${v.id}: ${v.description} (${v.nodes} elements)`,
              );
            }
          }
        } catch (axeErr) {
          console.warn(`  (Axe check error: ${axeErr.message})`);
        }
      }

      // Screenshot capture
      const shotFile = `${stepKey}-${vpName}.png`;
      const shotPath = join(SCREENSHOT_DIR, shotFile);
      const maskLocators = [];
      const linkMask = page.locator(
        '[data-testid="candidate-invitation-link"]',
      );
      if ((await linkMask.count()) > 0) {
        maskLocators.push(linkMask);
      }

      await page.screenshot({
        path: shotPath,
        fullPage: false,
        mask: maskLocators,
      });

      auditReport.steps.push({
        stepNum,
        stepName,
        viewport: vpName,
        shotFile,
        overflow,
        violations: vpName === 'desktop' ? violations : undefined,
      });
    }

    await page.setViewportSize(VIEWPORTS.desktop);
    await page.waitForTimeout(400);
  }

  try {
    const recruiterContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      bypassCSP: true,
      viewport: VIEWPORTS.desktop,
    });
    const recruiterPage = await recruiterContext.newPage();
    recruiterPage.on('console', (m) => recordConsole('Recruiter', m));
    recruiterPage.on('pageerror', (e) =>
      auditReport.pageErrors.push(`[Recruiter] ${e.message}`),
    );
    recruiterPage.on('request', (req) => {
      if (req.url().includes('/assessments/')) {
        console.log(`  [Recruiter Req] ${req.method()} ${req.url()}`);
      }
    });
    recruiterPage.on('response', (res) => {
      if (res.url().includes('/assessments/')) {
        console.log(`  [Recruiter Res] ${res.status()} ${res.url()}`);
      }
    });

    // =========================================================================
    // Step 1: Recruiter Sign-in
    // =========================================================================
    await recruiterPage.goto(`${origin}/r23/login`);
    await auditAndCapture(
      recruiterPage,
      1,
      'recruiter-signin',
      'Recruiter Sign-in Screen',
    );

    // Perform sign-in
    await recruiterPage.locator('input[name="email"]').fill(users.a.email);
    await recruiterPage
      .locator('input[name="password"]')
      .fill(users.a.password);
    await Promise.all([
      recruiterPage.waitForURL('**/r23/organizations'),
      recruiterPage.locator('button[type="submit"]').click(),
    ]);

    // =========================================================================
    // Step 2: Organization Selection
    // =========================================================================
    await auditAndCapture(
      recruiterPage,
      2,
      'org-selection',
      'Organization Selection Screen',
    );

    // Select org
    const orgForm = recruiterPage.locator('form').filter({
      has: recruiterPage.locator(`input[value="${FIXTURE_IDS.orgA}"]`),
    });
    await Promise.all([
      recruiterPage.waitForURL(`**/r23/organizations/${FIXTURE_IDS.orgA}`),
      orgForm.locator('button[type="submit"]').click(),
    ]);

    // =========================================================================
    // Step 3: Assessment Builder
    // =========================================================================
    await recruiterPage.goto(
      `${origin}/r23/organizations/${FIXTURE_IDS.orgA}/builder`,
    );
    await recruiterPage.waitForLoadState('load');
    await auditAndCapture(
      recruiterPage,
      3,
      'assessment-builder',
      'Assessment Builder (Define Stage)',
    );

    // =========================================================================
    // Step 4: Approved-template Selection (Reservation Moves v3)
    // =========================================================================
    const templateSelector = recruiterPage.getByLabel('Assessment template');
    await templateSelector.selectOption('custom');
    await recruiterPage.waitForTimeout(300);
    await templateSelector.selectOption('reservation-moves-v3');
    await recruiterPage.waitForTimeout(600);

    // Click Save draft button and wait for response
    const saveDraftBtn = recruiterPage.locator('[data-testid="save-draft-button"]');
    await saveDraftBtn.waitFor({ state: 'visible', timeout: 10000 });
    const [saveResponse] = await Promise.all([
      recruiterPage.waitForResponse(
        (res) =>
          res.url().includes('/assessments/draft') &&
          res.request().method() === 'PUT',
        { timeout: 20000 },
      ),
      saveDraftBtn.click(),
    ]);
    console.log(`  Save draft HTTP status: ${saveResponse.status()}`);
    assert.equal(saveResponse.status(), 200);
    await recruiterPage.waitForLoadState('load');

    await auditAndCapture(
      recruiterPage,
      4,
      'template-selected',
      'Assessment Builder: Reservation Moves v3 Template Selected',
    );

    // =========================================================================
    // Step 5: Assessment Issuance (Validate and Issue)
    // =========================================================================
    // Continue to Validate stage (triggers validation check)
    const [valResponse] = await Promise.all([
      recruiterPage.waitForResponse(
        (res) =>
          res.url().includes('/assessments/validate') &&
          res.request().method() === 'POST',
        { timeout: 15000 },
      ),
      recruiterPage
        .locator('[data-testid="continue-to-validate-button"]')
        .click(),
    ]);
    console.log(`  Validate HTTP status: ${valResponse.status()}`);
    assert.equal(valResponse.status(), 200);
    await recruiterPage.waitForLoadState('load');

    // Wait for validated version display
    await recruiterPage
      .locator('[data-testid="validated-version-display"]')
      .waitFor();

    // Advance to Issue stage
    await recruiterPage
      .locator('[data-testid="continue-to-issue-button"]')
      .click();
    await recruiterPage.waitForLoadState('load');

    // Select reviewer if dropdown exists
    const reviewerSelect = recruiterPage.locator(
      '[data-testid="issue-reviewer-select"]',
    );
    if ((await reviewerSelect.count()) > 0) {
      await reviewerSelect.selectOption({ index: 1 });
    }

    // Click Issue assessment button
    const issueButton = recruiterPage.locator(
      '[data-testid="issue-assessment-button"]',
    );
    const [issueRes] = await Promise.all([
      recruiterPage.waitForResponse(
        (res) =>
          res.url().includes('/sessions') &&
          res.request().method() === 'POST',
      ),
      issueButton.click(),
    ]);
    assert.equal(
      issueRes.status(),
      201,
      `Assessment issuance failed (HTTP ${issueRes.status()}): ${await issueRes.text()}`,
    );
    await recruiterPage.waitForLoadState('load');

    await auditAndCapture(
      recruiterPage,
      5,
      'assessment-issued',
      'Assessment Issuance Confirmed',
    );

    // =========================================================================
    // Step 6: Candidate Invitation Display
    // =========================================================================
    // In builder, candidate invitation panel is present. Create invitation if needed.
    const createInvButton = recruiterPage.locator(
      '[data-testid="candidate-invitation-create"]',
    );
    if (
      (await createInvButton.count()) > 0 &&
      (await createInvButton.isVisible())
    ) {
      await Promise.all([
        recruiterPage.waitForResponse(
          (res) =>
            res.url().includes('/candidate-token') &&
            res.request().method() === 'POST',
        ),
        createInvButton.click(),
      ]);
      await recruiterPage.waitForLoadState('load');
    }

    const invitationInput = recruiterPage.locator(
      '[data-testid="candidate-invitation-link"]',
    );
    await invitationInput.waitFor();
    const candidateInvitationUrl = await invitationInput.inputValue();
    assert.ok(
      candidateInvitationUrl.includes('/r26/candidate/sess_'),
      `Invalid invitation URL: ${candidateInvitationUrl}`,
    );

    // Extract session ID and fragment from invitation URL
    const parsedInvUrl = new URL(candidateInvitationUrl);
    const sessionId = parsedInvUrl.pathname.split('/').pop();
    const candidateToken = parsedInvUrl.hash.replace('#', '');
    assert.ok(sessionId, 'Missing sessionId');
    assert.ok(candidateToken, 'Missing candidate token in fragment');

    await auditAndCapture(
      recruiterPage,
      6,
      'invitation-display',
      'Candidate Invitation Display with Expiry & Bearer Link',
    );

    // =========================================================================
    // Step 7: Candidate Consent
    // =========================================================================
    const candidateContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      bypassCSP: true,
      viewport: VIEWPORTS.desktop,
    });
    const candidatePage = await candidateContext.newPage();
    candidatePage.on('console', (m) => recordConsole('Candidate', m));
    candidatePage.on('pageerror', (e) =>
      auditReport.pageErrors.push(`[Candidate] ${e.message}`),
    );

    await candidatePage.goto(candidateInvitationUrl);
    await candidatePage.waitForLoadState('load');

    const activateButton = candidatePage.getByRole('button', {
      name: 'Activate assessment',
      exact: true,
    });
    await activateButton.waitFor({ state: 'visible', timeout: 15000 });

    await auditAndCapture(
      candidatePage,
      7,
      'candidate-consent',
      'Candidate Pre-Start Notice & Affirmative Consent',
    );

    // =========================================================================
    // Step 8: Candidate Workspace
    // =========================================================================
    await Promise.all([
      candidatePage.waitForResponse(
        (res) =>
          res.url().includes(`/r26/api/candidate/${sessionId}`) &&
          res.request().method() === 'POST' &&
          res.request().postDataJSON()?.action === 'activate',
      ),
      activateButton.click(),
    ]);
    await candidatePage.waitForLoadState('load');

    // Verify workspace elements: editor, execution panel
    await candidatePage
      .locator('.cm-content[contenteditable="true"]')
      .waitFor();
    await candidatePage
      .locator('[data-testid="candidate-execution-panel"]')
      .waitFor();

    await auditAndCapture(
      candidatePage,
      8,
      'candidate-workspace',
      'Candidate Workspace (Editor, Files, Execution Panel, Capability Notices)',
    );

    // =========================================================================
    // Step 9: Save and Resume
    // =========================================================================
    // Edit code in editor
    const editor = candidatePage.locator('.cm-content[contenteditable="true"]');
    await editor.click();
    await candidatePage.keyboard.type(
      '\n# Verified candidate solution implementation\ndef resolve_move():\n    return "resolved"\n',
    );

    // Save work
    const saveWorkButton = candidatePage.getByRole('button', {
      name: 'Save work',
      exact: true,
    });
    await Promise.all([
      candidatePage.waitForResponse(
        (res) =>
          res.url().includes(`/r26/api/candidate/${sessionId}`) &&
          res.request().method() === 'POST' &&
          res.request().postDataJSON()?.action === 'save',
      ),
      saveWorkButton.click(),
    ]);
    await candidatePage.waitForLoadState('load');

    // Simulate Resume: reload page with the candidate token URL
    await candidatePage.reload();
    await candidatePage.waitForLoadState('load');
    await candidatePage
      .locator('.cm-content[contenteditable="true"]')
      .waitFor();

    await auditAndCapture(
      candidatePage,
      9,
      'save-and-resume',
      'Candidate Workspace: Save Confirmed & Resumed State',
    );

    // =========================================================================
    // Step 10: Submission Confirmation
    // =========================================================================
    const submitButton = candidatePage.getByRole('button', {
      name: 'Submit assessment',
      exact: true,
    });
    await submitButton.waitFor();
    await Promise.all([
      candidatePage.waitForResponse(
        (res) =>
          res.url().includes(`/r26/api/candidate/${sessionId}`) &&
          res.request().method() === 'POST' &&
          res.request().postDataJSON()?.action === 'submit',
      ),
      submitButton.click(),
    ]);
    await candidatePage.waitForLoadState('load');
    await candidatePage.locator('.r26-readonly-note').waitFor();

    await auditAndCapture(
      candidatePage,
      10,
      'submission-confirmation',
      'Candidate Submission Confirmation (Read-Only Terminal State)',
    );

    // =========================================================================
    // Step 11: Evaluator Evidence Workbench
    // =========================================================================
    const reviewerContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      bypassCSP: true,
      viewport: VIEWPORTS.desktop,
    });
    const reviewerPage = await reviewerContext.newPage();
    reviewerPage.on('console', (m) => recordConsole('Reviewer', m));
    reviewerPage.on('pageerror', (e) =>
      auditReport.pageErrors.push(`[Reviewer] ${e.message}`),
    );

    // Reviewer sign-in
    await reviewerPage.goto(`${origin}/r23/login`);
    await reviewerPage.locator('input[name="email"]').fill(users.ab.email);
    await reviewerPage
      .locator('input[name="password"]')
      .fill(users.ab.password);
    await Promise.all([
      reviewerPage.waitForURL('**/r23/organizations'),
      reviewerPage.locator('button[type="submit"]').click(),
    ]);

    // Select organization
    const reviewerOrgForm = reviewerPage.locator('form').filter({
      has: reviewerPage.locator(`input[value="${FIXTURE_IDS.orgA}"]`),
    });
    await Promise.all([
      reviewerPage.waitForURL(`**/r23/organizations/${FIXTURE_IDS.orgA}`),
      reviewerOrgForm.locator('button[type="submit"]').click(),
    ]);

    // Ensure session is assigned to reviewer if not already
    if (admin) {
      const existingAssignment = await admin.query(
        'SELECT 1 FROM hirearchy.reviewer_assignments WHERE organization_id = $1 AND session_id = $2 AND revoked_at IS NULL',
        [FIXTURE_IDS.orgA, sessionId],
      );
      if (existingAssignment.rowCount === 0) {
        await admin.query(
          `INSERT INTO hirearchy.reviewer_assignments (id, organization_id, session_id, reviewer_principal_id, assigned_by_principal_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            `asgn_${randomUUID()}`,
            FIXTURE_IDS.orgA,
            sessionId,
            FIXTURE_IDS.userAB.principalId,
            FIXTURE_IDS.userA.principalId,
          ],
        );
      }
    }

    // Open Evidence Workbench
    await reviewerPage.goto(
      `${origin}/r27/organizations/${FIXTURE_IDS.orgA}/sessions/${sessionId}`,
    );
    await reviewerPage.waitForLoadState('load');

    // Switch to Evidence tab
    const evidenceTab = reviewerPage.locator(
      '[data-workbench-mode-tab="evidence"]',
    );
    if ((await evidenceTab.count()) > 0) {
      await evidenceTab.click();
      await reviewerPage.waitForLoadState('load');
    }

    await auditAndCapture(
      reviewerPage,
      11,
      'evaluator-workbench',
      'Evaluator Evidence Workbench (Chronology, Diffs, Execution Runs)',
    );

    // =========================================================================
    // Step 12: Human Review Creation and Finalization
    // =========================================================================
    await reviewerPage.setViewportSize(VIEWPORTS.desktop);
    const mobileCloseInitial = reviewerPage.locator(
      'button:has-text("Back to evidence")',
    );
    if ((await mobileCloseInitial.count()) > 0 && (await mobileCloseInitial.first().isVisible())) {
      await mobileCloseInitial.first().click();
      await reviewerPage.waitForTimeout(300);
    }

    // 1. In Evidence tab, click a timeline event (e.g. Workspace save recorded or Session submitted) to reveal observation panel
    const timelineEventBtn = reviewerPage
      .getByRole('button', {
        name: /Workspace save recorded|Session submitted/i,
      })
      .first();
    await timelineEventBtn.waitFor({ state: 'visible', timeout: 10000 });
    await timelineEventBtn.click();

    const observationPanel = reviewerPage.locator(
      'section[aria-label="Anchored Observations"]',
    );
    await observationPanel.waitFor({ state: 'visible', timeout: 10000 });

    const obsNoteInput = observationPanel.getByRole('textbox', {
      name: 'Observation note',
    });
    await obsNoteInput.waitFor({ state: 'visible', timeout: 5000 });
    await obsNoteInput.fill(
      `Observed candidate saved clean implementation and test updates for session ${sessionId.slice(-8)}.`,
    );

    const saveObsBtn = observationPanel.getByRole('button', {
      name: 'Save observation',
    });
    const [obsRes] = await Promise.all([
      reviewerPage.waitForResponse(
        (r) =>
          r.url().includes('/observations') &&
          r.request().method() === 'POST',
        { timeout: 10000 },
      ),
      saveObsBtn.click(),
    ]);
    console.log(`  Save observation HTTP status: ${obsRes.status()}`);
    if (!obsRes.ok()) {
      console.error(`  Save observation error: ${await obsRes.text()}`);
    }
    await observationPanel
      .getByText('Observation saved.', { exact: true })
      .waitFor({ timeout: 10000 });

    const mobileCloseAfterObs = reviewerPage.locator(
      'button:has-text("Back to evidence")',
    );
    if ((await mobileCloseAfterObs.count()) > 0 && (await mobileCloseAfterObs.first().isVisible())) {
      await mobileCloseAfterObs.first().click();
      await reviewerPage.waitForTimeout(300);
    }

    // 2. Switch to Review tab
    const reviewTab = reviewerPage.locator(
      '[data-workbench-mode-tab="review"]',
    );
    await reviewTab.waitFor({ state: 'visible', timeout: 5000 });
    await reviewTab.click();

    const reviewPacket = reviewerPage.locator(
      '[data-testid="evaluator-review-packet"]',
    );
    await reviewPacket.waitFor({ state: 'visible', timeout: 15000 });

    const loadingNotice = reviewerPage.locator(
      'text=Loading human review packet...',
    );
    if ((await loadingNotice.count()) > 0) {
      await loadingNotice
        .waitFor({ state: 'detached', timeout: 15000 })
        .catch(() => {});
    }

    // Check the observation citation that was just created
    const obsCheckbox = reviewPacket
      .locator('label')
      .filter({ hasText: /Event #/ })
      .locator('input[type="checkbox"]');
    await obsCheckbox.first().waitFor({ state: 'visible', timeout: 10000 });
    await obsCheckbox.first().check();

    // Fill Review packet form
    const summaryInput = reviewPacket.getByRole('textbox', {
      name: 'Review summary',
    });
    await summaryInput.waitFor({ state: 'visible', timeout: 10000 });
    await summaryInput.fill(
      'Candidate implemented the required reservation move handling logic methodically with sound defensive practices.',
    );

    const strengthsInput = reviewPacket.getByRole('textbox', {
      name: 'Strengths',
    });
    if ((await strengthsInput.count()) > 0) {
      await strengthsInput.fill(
        'Clean function signature\nClear inline reasoning\nDefensive return value',
      );
    }

    const concernsInput = reviewPacket.getByRole('textbox', {
      name: 'Concerns',
    });
    if ((await concernsInput.count()) > 0) {
      await concernsInput.fill(
        'Edge-case concurrency tests not fully extended',
      );
    }

    const questionsInput = reviewPacket.getByRole('textbox', {
      name: 'Unresolved questions',
    });
    if ((await questionsInput.count()) > 0) {
      await questionsInput.fill(
        'How would you handle distributed locking across multiple instances?',
      );
    }

    // Save draft
    const saveDraftButton = reviewPacket.getByRole('button', {
      name: 'Save draft',
      exact: true,
    });
    await saveDraftButton.waitFor({ state: 'visible', timeout: 5000 });
    const [saveDraftRes] = await Promise.all([
      reviewerPage.waitForResponse(
        (r) =>
          r.url().includes('/review-packet') &&
          r.request().method() === 'PUT',
        { timeout: 15000 },
      ),
      saveDraftButton.click(),
    ]);
    console.log(`  Save draft HTTP status: ${saveDraftRes.status()}`);
    if (!saveDraftRes.ok()) {
      console.error(`  Save draft error: ${await saveDraftRes.text()}`);
    }
    await reviewPacket
      .getByText(/Draft saved at/i)
      .waitFor({ timeout: 10000 });

    // Finalize review packet
    const finalizeButton = reviewPacket.getByRole('button', {
      name: 'Finalize review packet',
      exact: true,
    });
    await finalizeButton.waitFor({ state: 'visible', timeout: 5000 });
    await finalizeButton.click();

    const confirmDialog = reviewerPage.getByRole('dialog', {
      name: 'Confirm Review Packet Finalization',
    });
    await confirmDialog.waitFor({ state: 'visible', timeout: 10000 });

    const confirmBtn = confirmDialog.getByRole('button', {
      name: 'Confirm and finalize',
      exact: true,
    });

    const [finalizeRes] = await Promise.all([
      reviewerPage.waitForResponse(
        (r) =>
          r.url().includes('/review-packet/finalize') &&
          r.request().method() === 'POST',
        { timeout: 15000 },
      ),
      confirmBtn.click(),
    ]);
    console.log(`  Finalize HTTP status: ${finalizeRes.status()}`);
    if (!finalizeRes.ok()) {
      console.error(`  Finalize error: ${await finalizeRes.text()}`);
    }

    await reviewerPage.waitForFunction(() => {
      const el = document.querySelector(
        '[data-testid="review-packet-status"]',
      );
      return el && el.textContent?.includes('FINALIZED');
    }, { timeout: 20000 });

    await reviewerPage
      .locator('[data-testid="review-packet-finalized-notice"]')
      .waitFor({ state: 'visible', timeout: 15000 });

    await auditAndCapture(
      reviewerPage,
      12,
      'evaluator-finalized',
      'Finalized Immutable Human Review Packet (No Automatic Hiring Verdict)',
    );

    await recruiterContext.close();
    await candidateContext.close();
    await reviewerContext.close();
  } finally {
    await browser.close();
  }

  return auditReport;
}
