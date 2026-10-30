import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPlaywright } from '../r25/browser-issuance-check.mjs';
import { FIXTURE_IDS } from '../../database/postgres/r23/adapter.mjs';
import { encryptCandidateToken } from '../../apps/web/src/sessions/candidate-token-storage.mjs';

export async function runR26BrowserCandidateChecks({
  origin,
  request,
  signInAndSelectOrg,
  users,
  admin,
  connection,
  _runtimePassword,
  candidateTokenKey,
  start,
  stop,
  evidence,
}) {
  const http = [];
  const errors = [];
  const consoleErrors = [];
  const recruiter = await signInAndSelectOrg(origin, users.a, FIXTURE_IDS.orgA);
  const recruiterB = await signInAndSelectOrg(
    origin,
    users.recruiterB,
    FIXTURE_IDS.orgB,
  );
  const reviewer = await signInAndSelectOrg(origin, users.ab, FIXTURE_IDS.orgA);
  const csrf = '__Host-r23-csrf';
  const issue = async (organizationId, cookies) => {
    const response = await request(
      origin,
      `/r23/api/organizations/${organizationId}/sessions`,
      {
        method: 'POST',
        cookies,
        headers: { Origin: origin, 'x-csrf-token': cookies[csrf] },
        body: {
          idempotencyKey: `r26-browser-${randomUUID()}`,
          scenarioId: 'scenario-002-booking-notification-retry',
          durationMinutes: 30,
        },
      },
    );
    assert.equal(response.status, 201);
    const issued = JSON.parse(response.text);
    assert.equal(
      issued.candidateBearerAvailabilityStatus,
      'isolated_editing_only',
    );
    const recovered = await request(
      origin,
      `/r23/api/organizations/${organizationId}/sessions/${issued.sessionId}/candidate-token`,
      { cookies },
    );
    assert.equal(recovered.status, 200);
    const recovery = JSON.parse(recovered.text);
    assert.equal(
      recovery.candidatePath,
      `/r26/candidate/${issued.sessionId}#${recovery.candidateToken}`,
    );
    return {
      id: issued.sessionId,
      token: recovery.candidateToken,
      path: recovery.candidatePath,
    };
  };
  const a = await issue(FIXTURE_IDS.orgA, recruiter);
  const a2 = await issue(FIXTURE_IDS.orgA, recruiter);
  const b = await issue(FIXTURE_IDS.orgB, recruiterB);
  const call = async (candidate, action = 'read', input, overrides = {}) => {
    const path = `/r26/api/candidate/${candidate.id}`;
    const result = await request(origin, path, {
      method: action === 'read' ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${candidate.token}`,
        ...(action !== 'read' ? { Origin: origin } : {}),
      },
      ...(action !== 'read' ? { body: { action, input: input ?? {} } } : {}),
      ...overrides,
    });
    http.push({ sessionId: candidate.id, action, status: result.status });
    assert.match(result.headers['cache-control'] ?? '', /private/);
    assert.match(result.headers['cache-control'] ?? '', /no-store/);
    assert.doesNotMatch(
      result.text,
      /candidateTokenHash|candidate_token_hash|candidate_token_ciphertext|organization_id|organizationId/,
    );
    return { ...result, data: JSON.parse(result.text) };
  };
  assert.equal((await call(a)).status, 200);
  for (const cookies of [recruiter, reviewer]) {
    const denied = await call(a, 'read', undefined, { headers: {}, cookies });
    assert.equal(
      denied.status,
      401,
      'Evaluator cookies cannot impersonate a candidate',
    );
  }
  for (const deniedCandidate of [
    { ...a2, token: a.token },
    { ...b, token: a.token },
    { ...a, token: b.token },
    { ...a, token: 'invalid-bearer' },
  ]) {
    const denied = await call(deniedCandidate);
    assert.ok([401, 403, 404].includes(denied.status));
    assert.equal(denied.data.files, undefined);
    assert.equal(denied.data.scenario, undefined);
  }

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
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => {
    console.log('BROWSER_CONSOLE:', msg.type(), msg.text());
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  const screenshot = (name) =>
    page.screenshot({
      path: join(evidence, `r26-${name}.png`),
      fullPage: true,
    });
  const waitPost = (action) =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/r26/api/candidate/${a.id}`) &&
        response.request().method() === 'POST' &&
        response.request().postDataJSON()?.action === action,
    );
  const append = async (text) => {
    const editor = page.locator('.cm-content');
    await editor.click();
    await editor.press('ControlOrMeta+End');
    await editor.press('End');
    await editor.press('Enter');
    await editor.pressSequentially(text);
  };
  const editorText = async () =>
    page.evaluate(() => {
      const content = document.querySelector('.cm-content');
      const editor = document.querySelector('.cm-editor');
      const tile = (content && content.cmTile) || (editor && editor.cmTile);
      const view = tile?.root?.view || editor?.cmView?.view || editor?.cmView;
      if (!view?.state?.doc)
        throw new Error('CodeMirror EditorView unavailable');
      return view.state.doc.toString();
    });
  const waitWorkspace = async () => {
    await page.getByLabel('Workspace file').waitFor();
    await page.getByLabel('Workspace file').selectOption('bookings/service.py');
    await page.locator('.cm-content').waitFor();
  };
  try {
    await page.goto(origin + a.path);
    await page
      .getByRole('button', { name: 'Activate assessment', exact: true })
      .waitFor();
    assert.equal(
      new URL(page.url()).hash,
      '',
      'Bearer fragment is removed before interaction',
    );
    assert.match(await page.textContent('body'), /The second confirmation/);
    assert.match(await page.textContent('body'), /unavailable/i);
    await screenshot('01-issued');
    const activatedResponse = waitPost('activate');
    await page
      .getByRole('button', { name: 'Activate assessment', exact: true })
      .click();
    assert.equal((await activatedResponse).status(), 200);
    await waitWorkspace();
    const activated = (await call(a)).data;
    assert.equal(activated.status, 'ACTIVE');
    assert.equal(
      Date.parse(activated.deadline) - Date.parse(activated.activatedAt),
      1800 * 1000,
    );
    await page.getByLabel('Assessment timer').waitFor();
    await screenshot('02-active');
    const baseline = activated.files.find(
      (file) => file.path === 'bookings/service.py',
    );
    assert.ok(baseline);
    await append('# r26-browser-save-one');
    const saveResponse = waitPost('save');
    await page.getByRole('button', { name: 'Save work', exact: true }).click();
    assert.equal((await saveResponse).status(), 200);
    let saved = (await call(a)).data;
    assert.match(
      saved.files.find((file) => file.path === baseline.path).content,
      /r26-browser-save-one/,
    );
    await page.reload();
    await waitWorkspace();
    assert.match(await editorText(), /r26-browser-save-one/);
    await screenshot('03-saved-reloaded');
    await stop();
    await start();
    await page.goto(origin + a.path);
    await waitWorkspace();
    assert.match(await editorText(), /r26-browser-save-one/);
    assert.equal((await call(a)).data.activatedAt, activated.activatedAt);
    await append('# r26-browser-save-two');
    const secondSave = waitPost('save');
    await page.getByRole('button', { name: 'Save work', exact: true }).click();
    assert.equal((await secondSave).status(), 200);
    saved = (await call(a)).data;
    assert.equal(
      saved.events.filter((event) => event.type === 'WORKSPACE_CHANGED').length,
      2,
    );
    const file = saved.files.find((file) => file.path === baseline.path);
    await append('# local-conflicting-change');
    const remote = await call(a, 'save', {
      requestId: randomUUID(),
      path: file.path,
      content: file.content + '\n# competing-tab-save\n',
      expectedVersion: file.version,
    });
    assert.equal(remote.status, 200);
    const conflict = waitPost('save');
    await page.getByRole('button', { name: 'Save work', exact: true }).click();
    assert.equal((await conflict).status(), 409);
    await page.getByRole('alert').waitFor();
    assert.match(await editorText(), /local-conflicting-change/);
    await screenshot('04-save-conflict');
    await page.reload();
    await waitWorkspace();
    assert.match(await editorText(), /competing-tab-save/);
    assert.doesNotMatch(await editorText(), /local-conflicting-change/);

    // Bearer authority is independent of the evaluator's login lifecycle.
    const logout = await request(origin, '/r23/auth/logout', {
      method: 'POST',
      cookies: recruiter,
      headers: { Origin: origin, 'x-csrf-token': recruiter[csrf] },
      body: { csrf: recruiter[csrf] },
    });
    assert.ok([204, 303].includes(logout.status));
    assert.equal((await call(a)).status, 200);
    await stop();
    await start();
    await page.goto(origin + a.path);
    await waitWorkspace();
    const beforeSubmission = (await call(a)).data;
    const submittedResponse = waitPost('submit');
    await page
      .getByRole('button', { name: 'Submit assessment', exact: true })
      .click();
    assert.equal((await submittedResponse).status(), 200);
    await page.getByText('Submitted', { exact: true }).first().waitFor();
    const submitted = (await call(a)).data;
    assert.equal(submitted.status, 'SUBMITTED');
    assert.equal(submitted.closureReason, 'candidate_submission');
    assert.equal(
      submitted.submission.workspaceDigest,
      beforeSubmission.workspaceDigest,
    );
    assert.deepEqual(submitted.submission.files, beforeSubmission.files);
    assert.equal(
      await page.locator('.cm-content[contenteditable="true"]').count(),
      0,
    );
    await screenshot('05-submitted');
    const rejectedSave = await call(a, 'save', {
      requestId: randomUUID(),
      path: file.path,
      content: 'post-finality-change',
      expectedVersion: submitted.files.find((f) => f.path === file.path)
        .version,
    });
    assert.equal(rejectedSave.status, 409);
    const changedClosure = await call(a, 'submit', {
      requestId: randomUUID(),
      expectedWorkspaceDigest: '0'.repeat(64),
    });
    assert.equal(changedClosure.status, 409);
    await stop();
    await start();
    await page.goto(origin + a.path);
    await page.getByText('Submitted', { exact: true }).first().waitFor();
    const recovered = (await call(a)).data;
    assert.deepEqual(recovered.submission, submitted.submission);
    assert.deepEqual(recovered.events, submitted.events);
    assert.deepEqual(recovered.files, submitted.files);
    assert.equal(recovered.scenarioDigest, activated.scenarioDigest);
    assert.equal(
      recovered.events.filter((event) => event.type === 'SESSION_SUBMITTED')
        .length,
      1,
    );
    assert.ok(
      recovered.events.every(
        (event) => !/(?:COMMAND|AI_|VERIFICATION)/.test(event.type),
      ),
    );
    recovered.events.forEach((event, index) =>
      assert.equal(event.sequence, String(index + 1)),
    );
    for (const entry of recovered.files)
      assert.equal(
        entry.digest,
        createHash('sha256').update(entry.content).digest('hex'),
      );
    await screenshot('06-restarted-frozen');

    // Explicit synthetic fixtures exercise legacy bearers and a short deadline.
    const seedCandidate = async (durationSeconds, tokenBytes) => {
      const candidate = {
        id: `sess_r26_fixture_${randomUUID()}`,
        token: randomBytes(tokenBytes).toString('base64url'),
      };
      await admin.query(
        `INSERT INTO hirearchy.assessment_sessions(id,organization_id,issuer_principal_id,scenario_id,scenario_version,scenario_title,duration_seconds,terminal_enabled,task_rubric_snapshot,ai_capability_snapshot,scenario_snapshot)
        SELECT $1,organization_id,issuer_principal_id,scenario_id,scenario_version,scenario_title,$3,terminal_enabled,task_rubric_snapshot,ai_capability_snapshot,jsonb_set(scenario_snapshot::jsonb,'{scenario,durationSeconds}',to_jsonb($3::integer))::text FROM hirearchy.assessment_sessions WHERE id=$2`,
        [candidate.id, a.id, durationSeconds],
      );
      await admin.query(
        'INSERT INTO hirearchy.candidate_token_envelopes(organization_id,session_id,candidate_token_hash,candidate_token_ciphertext) VALUES($1,$2,$3,$4)',
        [
          FIXTURE_IDS.orgA,
          candidate.id,
          createHash('sha256').update(candidate.token).digest('hex'),
          encryptCandidateToken(
            candidate.token,
            candidate.id,
            Buffer.from(candidateTokenKey, 'base64'),
          ),
        ],
      );
      return candidate;
    };
    const legacy = await seedCandidate(1800, 24);
    assert.equal(
      (await call(legacy)).status,
      200,
      'Previously issued 24-byte bearer format remains admitted',
    );
    await page.goto(`${origin}/r26/candidate/${legacy.id}#${legacy.token}`);
    await page
      .getByRole('button', { name: 'Activate assessment', exact: true })
      .waitFor();
    assert.equal(new URL(page.url()).hash, '');
    const timed = await seedCandidate(3, 32);
    await page.goto(`${origin}/r26/candidate/${timed.id}#${timed.token}`);
    await page
      .getByRole('button', { name: 'Activate assessment', exact: true })
      .waitFor();
    await page
      .getByRole('button', { name: 'Activate assessment', exact: true })
      .click();
    await waitWorkspace();
    await append('# local-unsubmitted-timeout-draft');
    await page
      .getByText('Submitted', { exact: true })
      .first()
      .waitFor({ timeout: 15000 });
    const timedView = (await call(timed)).data;
    assert.equal(timedView.status, 'SUBMITTED');
    assert.equal(timedView.closureReason, 'timeout');
    assert.ok(
      timedView.files.every(
        (file) => !file.content.includes('local-unsubmitted-timeout-draft'),
      ),
    );
    assert.doesNotMatch(
      await editorText(),
      /local-unsubmitted-timeout-draft/,
      'Read-only workspace shows frozen server evidence, not an unsaved local draft',
    );
    await screenshot('07-timeout');

    // No raw DB failure or fake empty workspace when the restricted connection fails.
    await stop();
    await start({
      R26_DATABASE_URL: `postgres://app_candidate_gateway:invalid-synthetic-password@127.0.0.1:${connection.port}/postgres`,
    });
    await page.goto(`${origin}/r26/candidate/${a.id}#${a.token}`);
    await page.getByRole('alert').waitFor();
    assert.match(
      await page.textContent('body'),
      /unavailable|retry|try again/i,
    );
    const unavailable = await call(a);
    assert.equal(unavailable.status, 503);
    assert.doesNotMatch(
      unavailable.text,
      /password|postgres:\/\/|SELECT |authentication failed|28P01/i,
    );
    await screenshot('08-dependency-error');
    await page.goto('about:blank');
    await stop();
    await start();
    await page.goto(origin + a.path);
    await page.getByText('Submitted', { exact: true }).first().waitFor();
    assert.deepEqual((await call(a)).data.submission, submitted.submission);
    assert.deepEqual(errors, [], 'No browser page errors');
    // Only deliberate 409/503 resource failures and dev-server HMR reconnects may reach Chromium's console.
    assert.ok(
      consoleErrors.every(
        (message) =>
          /Failed to load resource.*(?:409|503)/.test(message) ||
          /^WebSocket connection to 'wss:\/\/127\.0\.0\.1:\d+\/_next\/hmr\?id=[^']+' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED$/.test(
            message,
          ),
      ),
      `Unexpected browser console error: ${JSON.stringify(consoleErrors)}`,
    );
    writeFileSync(
      join(evidence, 'r26-browser-evidence.json'),
      JSON.stringify(
        {
          http,
          pageErrors: errors,
          consoleErrors,
          sessionId: a.id,
          scenarioDigest: recovered.scenarioDigest,
          activatedAt: recovered.activatedAt,
          deadline: recovered.deadline,
          submission: recovered.submission,
          eventTypes: recovered.events.map((e) => e.type),
          sequences: recovered.events.map((e) => e.sequence),
          timedClosure: timedView.closureReason,
        },
        null,
        2,
      ),
    );
    console.log(
      'PASS R2.6 HTTPS candidate issuance, bearer isolation, editor saves/conflict, restart durability, timeout and immutable submission',
    );
  } finally {
    await context.close();
    await browser.close();
  }
}
