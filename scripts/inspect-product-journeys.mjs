import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const axeSource = await fs.readFile(require.resolve('axe-core'), 'utf8');
const baseUrl = process.env.HIREARCHY_BASE_URL ?? 'http://localhost:3321';
const evaluatorKey = process.env.HIREARCHY_EVALUATOR_KEY;
if (!evaluatorKey) throw new Error('HIREARCHY_EVALUATOR_KEY is required');
const databasePath = process.env.HIREARCHY_DB_PATH;
if (!databasePath) throw new Error('HIREARCHY_DB_PATH is required');

const outputDir = path.resolve('docs/evidence/bootstrap-2026-10-19/browser');
await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
});
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(error.message));

const checkpoints = [];
let expirationObserved = null;
const checkpoint = async (name, screenshot = true) => {
  await page.waitForLoadState('networkidle');
  await page.addScriptTag({ content: axeSource });
  const [body, layout, axe] = await Promise.all([
    page.locator('body').innerText(),
    page.evaluate(() => ({
      viewportWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      viewportHeight: document.documentElement.clientHeight,
      scrollHeight: document.documentElement.scrollHeight,
    })),
    page.evaluate(async () => {
      const result = await globalThis.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
      });
      return result.violations.map(({ id, impact, nodes }) => ({
        id,
        impact,
        targets: nodes.slice(0, 5).map((node) => node.target),
      }));
    }),
  ]);
  if (screenshot)
    await page.screenshot({
      path: path.join(outputDir, `${name}.png`),
      fullPage: true,
    });
  checkpoints.push({
    name,
    url: page.url(),
    title: await page.title(),
    body: body.slice(0, 4000),
    layout,
    horizontalOverflow: layout.scrollWidth > layout.viewportWidth,
    axe,
  });
};

try {
  await page.goto(`${baseUrl}/evaluator`);
  await checkpoint('01-evaluator-sign-in');

  await page.getByLabel('Evaluator credential').fill('wrong-credential');
  await page.getByRole('button', { name: 'Continue to review queue' }).click();
  await page.getByText('The evaluator credential is not valid.').waitFor();
  await checkpoint('02-evaluator-invalid-credential');

  await page.getByLabel('Evaluator credential').fill(evaluatorKey);
  await page.getByRole('button', { name: 'Continue to review queue' }).click();
  await page.getByRole('heading', { name: 'Reviews' }).waitFor();
  await page
    .getByText('No submitted assessments are available for review.')
    .waitFor();
  await checkpoint('03-evaluator-empty-queue');

  await page.getByRole('link', { name: 'Create assessment' }).click();
  await page.getByRole('heading', { name: 'Shape the assessment.' }).waitFor();
  await checkpoint('04-assessment-builder');
  await page.setViewportSize({ width: 390, height: 844 });
  await checkpoint('04a-assessment-builder-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const [label, option] of [
    ['Technical field', 'Backend engineering'],
    ['Stack', 'Python · Flask'],
    ['Domain', 'Travel and bookings'],
    ['Scope', 'Layered'],
    ['Challenge', 'Investigate a production incident'],
  ]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  }
  await page.getByLabel('60 minutes', { exact: true }).check();
  await page
    .getByRole('button', { name: 'Generate and validate task' })
    .click();
  await page
    .getByText(
      'Task generation is unavailable right now. Try again later or contact your workspace administrator.',
    )
    .waitFor();
  await checkpoint('04b-assessment-generation-unavailable');

  const created = await context.request.post(`${baseUrl}/api/sessions`, {
    data: { scenarioId: 'scenario-001-cache-staleness' },
  });
  const createdBody = await created.json();
  if (created.status() !== 201) {
    throw new Error(
      `Session creation failed: ${created.status()} ${JSON.stringify(createdBody)}`,
    );
  }

  await page.goto(`${baseUrl}${createdBody.candidatePath}`);
  await page
    .getByRole('heading', {
      name: 'Stale storefront inventory after warehouse restock',
    })
    .waitFor();
  await checkpoint('05-candidate-entry-desktop');

  await page.setViewportSize({ width: 390, height: 844 });
  await checkpoint('06-candidate-entry-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.getByRole('button', { name: 'Continue to orientation' }).click();
  await page
    .getByRole('heading', {
      name: 'Assessment Guidelines & Environment',
    })
    .waitFor();
  await checkpoint('07-candidate-orientation');
  await page.getByRole('button', { name: 'Continue to start' }).click();
  await page.getByRole('button', { name: 'Start Assessment' }).click();
  await page.getByText('Time remaining', { exact: true }).waitFor({
    timeout: 120_000,
  });
  await checkpoint('08-candidate-workspace');
  await page.getByRole('button', { name: 'Weft', exact: true }).click();
  await page
    .getByText('Integrated AI assistance is not enabled for this assessment.')
    .waitFor();
  await checkpoint('08b-candidate-ai-unavailable');
  await page.setViewportSize({ width: 390, height: 844 });
  await checkpoint('08c-candidate-workspace-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Task', exact: true }).click();

  const editor = page.locator('.cm-content');
  if (await editor.count()) {
    await editor.click();
    await editor.press('Control+A');
    await page.keyboard.insertText(
      "export const formatInventory = () => 'browser-inspection';\n",
    );
    await page.waitForTimeout(900);
  }
  const saveButton = page.getByRole('button', { name: /save/i }).first();
  if (await saveButton.count()) await saveButton.click();
  await page.waitForTimeout(900);
  await checkpoint('09-candidate-after-save');
  await page.reload();
  await page.getByText('Time remaining', { exact: true }).waitFor();
  await page.getByText('Saved', { exact: true }).waitFor();
  await checkpoint('09b-candidate-returned-active');

  await page.getByRole('button', { name: 'Review submission' }).click();
  await page.getByRole('heading', { name: 'Review your submission' }).waitFor();
  await checkpoint('10-candidate-submission-review');
  await page.getByRole('button', { name: 'Submit Assessment' }).click();
  await page.getByRole('heading', { name: 'Assessment submitted' }).waitFor({
    timeout: 120_000,
  });
  await page.getByText('No follow-up requests are waiting.').waitFor();
  await checkpoint('11-candidate-submitted');

  await page.goto(`${baseUrl}/evaluator`);
  await page.getByRole('heading', { name: 'Reviews' }).waitFor();
  await page
    .getByText('Stale storefront inventory after warehouse restock')
    .waitFor();
  await checkpoint('12-evaluator-queue-submitted');
  await page
    .getByRole('link', { name: new RegExp(`session ${createdBody.sessionId}`) })
    .click();
  await page.getByRole('heading', { name: 'Evaluator review' }).waitFor();
  await page.getByText('No note saved yet.').waitFor();
  await page.getByText('Loading task analysis…').waitFor({ state: 'hidden' });
  await checkpoint('13-evaluator-review');
  await page.setViewportSize({ width: 390, height: 844 });
  await checkpoint('13a-evaluator-review-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page
    .getByRole('textbox', { name: 'Review note' })
    .fill('Browser trial: review remains grounded in the recorded work.');
  await page.getByRole('button', { name: 'Save decision note' }).click();
  await page.getByText('Note saved for this review.').waitFor();
  await page.locator('summary').filter({ hasText: 'Follow-up record' }).click();
  await page
    .getByLabel('Next step', { exact: true })
    .selectOption('technical_review');
  await page
    .getByLabel('Context (optional)')
    .fill('Have another engineer inspect the source-linked evidence.');
  await page.getByRole('button', { name: 'Save next step' }).click();
  await page.getByText('Human next step recorded.').waitFor();
  await checkpoint('13b-evaluator-human-next-step');

  await page
    .locator('summary')
    .filter({ hasText: 'Candidate clarification' })
    .click();
  await page
    .getByLabel('Question')
    .fill('Which trade-off would you revisit first?');
  await page.getByRole('button', { name: 'Record request' }).click();
  await page.getByText('Clarification request recorded').waitFor();
  await checkpoint('14-evaluator-clarification-requested');

  await page.goto(`${baseUrl}${createdBody.candidatePath}`);
  await page.getByText('Which trade-off would you revisit first?').waitFor();
  await page
    .getByLabel(/Your reply/)
    .fill('I would first revisit cache invalidation timing.');
  await page.getByRole('button', { name: 'Record reply' }).click();
  await page.getByText('Reply recorded.').waitFor();
  await checkpoint('15-candidate-clarification-replied');

  const expiring = await context.request.post(`${baseUrl}/api/sessions`, {
    data: { scenarioId: 'scenario-001-cache-staleness' },
  });
  const expiringBody = await expiring.json();
  if (expiring.status() !== 201)
    throw new Error(`Expiring session creation failed: ${expiring.status()}`);
  await page.goto(`${baseUrl}${expiringBody.candidatePath}`);
  await page.getByRole('button', { name: 'Continue to orientation' }).click();
  await page.getByRole('button', { name: 'Continue to start' }).click();
  await page.getByRole('button', { name: 'Start Assessment' }).click();
  await page.getByText('Time remaining', { exact: true }).waitFor({
    timeout: 120_000,
  });
  const database = new Database(databasePath);
  database
    .prepare('UPDATE assessment_sessions SET activated_at = ? WHERE id = ?')
    .run(
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      expiringBody.sessionId,
    );
  database.close();
  const expirationTransitions = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.reload();
    const expirationDatabase = new Database(databasePath, { readonly: true });
    const databaseState = expirationDatabase
      .prepare(
        'SELECT status, closure_reason AS closureReason FROM assessment_sessions WHERE id = ?',
      )
      .get(expiringBody.sessionId);
    expirationDatabase.close();
    const renderedHeading = await page.locator('h1').first().innerText();
    expirationTransitions.push({ renderedHeading, database: databaseState });
    if (renderedHeading === 'Assessment time ended') break;
    await page.waitForTimeout(1000);
  }
  expirationObserved = {
    expectedHeading: 'Assessment time ended',
    transitions: expirationTransitions,
  };
  await checkpoint('16-candidate-expired');

  await page.goto(`${baseUrl}/candidate/not-a-real-token`);
  await checkpoint('17-candidate-invalid-token');

  await fs.writeFile(
    path.join(outputDir, 'browser-results.json'),
    `${JSON.stringify(
      {
        baseUrl,
        created: {
          sessionId: createdBody.sessionId,
          candidatePath: createdBody.candidatePath,
        },
        expirationObserved,
        checkpoints,
        consoleErrors,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await context.close();
  await browser.close();
}
