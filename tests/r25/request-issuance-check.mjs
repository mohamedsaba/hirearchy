import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { FIXTURE_IDS } from '../../database/postgres/r23/adapter.mjs';
import { encryptCandidateToken } from '../../apps/web/src/sessions/candidate-token-storage.mjs';
import { runR25BrowserIssuanceChecks } from './browser-issuance-check.mjs';

const sessionCookie = '__Host-r23-session';
const csrfCookie = '__Host-r23-csrf';

function request(
  origin,
  path,
  { method = 'GET', cookies = {}, body, headers = {} } = {},
) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = httpsRequest(
      new URL(path, origin),
      {
        method,
        rejectUnauthorized: false,
        headers: {
          ...(Object.keys(cookies).length
            ? {
                Cookie: Object.entries(cookies)
                  .map(([k, v]) => `${k}=${v}`)
                  .join('; '),
              }
            : {}),
          ...(encoded
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(encoded),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.setTimeout(30000, () => req.destroy(new Error('Next request timeout')));
    req.on('error', reject);
    req.end(encoded);
  });
}

function cookieJar(response) {
  const jar = {};
  for (const line of response.headers['set-cookie'] ?? []) {
    const [pair] = line.split(';');
    const split = pair.indexOf('=');
    jar[pair.slice(0, split)] = pair.slice(split + 1);
  }
  return jar;
}

function assertPrivateNoStore(response, label) {
  const cc = response.headers['cache-control'] ?? '';
  assert.match(cc, /private/i, `${label} must include Cache-Control: private`);
  assert.match(
    cc,
    /no-store/i,
    `${label} must include Cache-Control: no-store`,
  );
  assert.doesNotMatch(
    cc,
    /(?:public|s-maxage)/i,
    `${label} must not be public or shared-cacheable`,
  );
}

function assertNoCandidateBearer(response, label, knownToken) {
  if (knownToken) {
    assert.equal(
      response.text.includes(knownToken),
      false,
      `${label} must not disclose the original candidate bearer`,
    );
  }
  const body = JSON.parse(response.text);
  assert.equal(
    Object.hasOwn(body, 'candidateToken'),
    false,
    `${label} must not contain candidateToken`,
  );
}

async function freePort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function signInAndSelectOrg(origin, user, organizationId) {
  const loginRes = await request(origin, '/r23/auth/login', {
    method: 'POST',
    headers: { Origin: origin },
    body: { email: user.email, password: user.password },
  });
  assert.equal(loginRes.status, 303);
  const jar1 = cookieJar(loginRes);

  const cbRes = await request(origin, '/r23/auth/callback', {
    cookies: jar1,
  });
  assert.equal(cbRes.status, 303);
  const jar = {
    [sessionCookie]: jar1[sessionCookie],
    [csrfCookie]: jar1[csrfCookie],
  };

  if (organizationId) {
    const selectRes = await request(origin, '/r23/organization', {
      method: 'POST',
      cookies: jar,
      headers: {
        Origin: origin,
        'x-csrf-token': jar[csrfCookie],
      },
      body: {
        organizationId,
        csrf: jar[csrfCookie],
      },
    });
    assert.equal(selectRes.status, 303);
  }

  return jar;
}

export async function runR25RequestAndBrowserChecks({
  admin,
  connection,
  runtimePassword,
  candidateTokenKey,
  authUrl,
  issuer,
  audience,
  users,
  authCall,
  evidenceDir,
  extraEnv = {},
  candidateChecks,
}) {
  const evidence =
    evidenceDir ?? mkdtempSync(join(tmpdir(), 'hirearchy-r25-https-'));
  mkdirSync(evidence, { recursive: true });
  const key = join(evidence, 'key.pem');
  const cert = join(evidence, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );

  const port = await freePort();
  const origin = `https://127.0.0.1:${port}`;
  const databaseUrl = `postgres://r23_gateway:${runtimePassword}@127.0.0.1:${connection.port}/postgres`;
  assert.equal(
    Buffer.from(candidateTokenKey, 'base64').length,
    32,
    'Runner must provide the same 32-byte key used to bind the disposable database',
  );
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    HIREARCHY_R23_DISPOSABLE: '1',
    R23_AUTH_URL: authUrl,
    R23_AUTH_ISSUER: issuer,
    R23_AUTH_AUDIENCE: audience,
    R23_DATABASE_URL: databaseUrl,
    R23_PUBLIC_ORIGIN: origin,
    R23_SESSION_KEY: randomBytes(32).toString('base64'),
    R23_APP_SESSION_TTL_SECONDS: '900',
    NEXT_TELEMETRY_DISABLED: '1',
    HIREARCHY_DB_PATH: join(evidence, 'legacy-synthetic.sqlite'),
    HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY: candidateTokenKey,
    HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_OLD_KEY: '',
    OPENROUTER_KEY: '',
    NVIDIA_API_KEY: '',
    ...extraEnv,
  };

  let next;
  let log;
  const start = async (overrides = {}) => {
    log = openSync(join(evidence, `next-${Date.now()}.log`), 'a', 0o600);
    next = spawn(
      process.execPath,
      [
        'node_modules/next/dist/bin/next',
        'dev',
        'apps/web',
        '-H',
        '127.0.0.1',
        '-p',
        String(port),
        '--experimental-https',
        '--experimental-https-key',
        key,
        '--experimental-https-cert',
        cert,
      ],
      {
        env: { ...env, ...overrides },
        stdio: ['ignore', log, log],
        detached: true,
      },
    );
    for (let i = 0; i < 120; i++) {
      if (next.exitCode !== null) throw new Error('Next exited during startup');
      try {
        if ((await request(origin, '/r23/login')).status < 500) {
          await delay(250);
          return;
        }
      } catch {
        // bounded readiness polling
      }
      await delay(250);
    }
    throw new Error('Next readiness failed');
  };

  const stop = async () => {
    if (next && next.exitCode === null) {
      process.kill(-next.pid, 'SIGTERM');
      await once(next, 'exit');
    }
    if (log !== undefined) closeSync(log);
    next = undefined;
    log = undefined;
  };

  try {
    // 1. Check disabled boundary
    await start({ HIREARCHY_R23_DISPOSABLE: '0' });
    for (const testPath of [
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/reviewers`,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/s-dummy/candidate-token`,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/s-dummy/assignments`,
    ]) {
      const res = await request(origin, testPath, { method: 'POST', body: {} });
      assert.equal(
        res.status,
        404,
        `Disabled R2.3 boundary must return 404 for ${testPath}`,
      );
    }
    await stop();

    // 2. Start active server
    await start();

    // 3. Unauthenticated requests to all endpoints -> 401
    const unauthIssue = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      { method: 'POST', body: {} },
    );
    assert.equal(
      unauthIssue.status,
      401,
      'Unauthenticated issuance must return 401',
    );

    // Bind GoTrue user subjects to fixture application principals
    const userToPrincipal = [
      [users.a, FIXTURE_IDS.userA.principalId],
      [users.b, FIXTURE_IDS.userB.principalId],
      [users.ab, FIXTURE_IDS.userAB.principalId],
      [users.revoked, FIXTURE_IDS.userRevoked.principalId],
      [users.recruiterA2, FIXTURE_IDS.recruiterA2.principalId],
      [users.adminA, FIXTURE_IDS.adminA.principalId],
      [users.recruiterB, FIXTURE_IDS.recruiterB.principalId],
    ];
    await admin.query(
      'ALTER TABLE hirearchy.application_principals DISABLE TRIGGER USER',
    );
    for (const [user, principalId] of userToPrincipal) {
      if (!user) continue;
      const tokenRes = await authCall('/token?grant_type=password', user);
      const subject = JSON.parse(
        Buffer.from(
          tokenRes.access_token.split('.')[1],
          'base64url',
        ).toString(),
      ).sub;
      await admin.query(
        'UPDATE hirearchy.application_principals SET auth_user_id = $1 WHERE id = $2',
        [subject, principalId],
      );
      await admin.query(
        `INSERT INTO r23.principal_subject_bindings (subject_id, principal_id)
         VALUES ($1, $2)
         ON CONFLICT (principal_id) DO UPDATE SET subject_id = EXCLUDED.subject_id`,
        [subject, principalId],
      );
    }
    await admin.query(
      'ALTER TABLE hirearchy.application_principals ENABLE TRIGGER USER',
    );

    // Sign in users
    const jarRecruiterA = await signInAndSelectOrg(
      origin,
      users.a,
      FIXTURE_IDS.orgA,
    );
    const jarRecruiterA2 = await signInAndSelectOrg(
      origin,
      users.recruiterA2,
      FIXTURE_IDS.orgA,
    );
    const jarRecruiterB = await signInAndSelectOrg(
      origin,
      users.recruiterB,
      FIXTURE_IDS.orgB,
    );
    const jarReviewerAB = await signInAndSelectOrg(
      origin,
      users.ab,
      FIXTURE_IDS.orgA,
    );
    const jarAdminA = await signInAndSelectOrg(
      origin,
      users.adminA,
      FIXTURE_IDS.orgA,
    );

    // 4. CSRF and Origin checks on POST
    const missingCsrf = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      {
        method: 'POST',
        cookies: jarRecruiterA,
        headers: { Origin: origin },
        body: { scenarioId: 'scenario-002-booking-notification-retry' },
      },
    );
    assert.equal(missingCsrf.status, 403, 'Missing CSRF token must return 403');

    const wrongOrigin = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      {
        method: 'POST',
        cookies: jarRecruiterA,
        headers: {
          Origin: 'https://evil.attacker.test',
          'x-csrf-token': jarRecruiterA[csrfCookie],
        },
        body: { scenarioId: 'scenario-002-booking-notification-retry' },
      },
    );
    assert.equal(
      wrongOrigin.status,
      403,
      'Wrong Origin header must return 403',
    );

    // 5. Authorized Issuance: Recruiter A in Org A (Case A: First issuance)
    const idempotencyKey1 = `key-suite-1-${Date.now()}`;
    const issueRes1 = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      {
        method: 'POST',
        cookies: jarRecruiterA,
        headers: {
          Origin: origin,
          'x-csrf-token': jarRecruiterA[csrfCookie],
        },
        body: {
          idempotencyKey: idempotencyKey1,
          scenarioId: 'scenario-002-booking-notification-retry',
          durationMinutes: 60,
        },
      },
    );
    assert.equal(issueRes1.status, 201, 'Fresh issuance returns 201 Created');
    assertPrivateNoStore(issueRes1, 'Assessment issuance response');
    const issue1 = JSON.parse(issueRes1.text);
    assert.ok(issue1.sessionId, 'Returns session ID');
    assert.equal(issue1.organizationId, FIXTURE_IDS.orgA);
    assert.equal(issue1.scenarioId, 'scenario-002-booking-notification-retry');
    assert.equal(issue1.scenarioVersion, '1.0.0');
    assert.equal(issue1.scenarioTitle, 'The second confirmation');
    assert.equal(issue1.status, 'CREATED');
    assert.equal(issue1.isReplay, false);
    assert.equal(
      issue1.candidateBearerAvailabilityStatus,
      extraEnv.HIREARCHY_R26_DISPOSABLE === '1'
        ? 'isolated_editing_only'
        : 'runtime_not_activated',
    );
    assert.equal(
      issue1.candidatePath,
      extraEnv.HIREARCHY_R26_DISPOSABLE === '1'
        ? `/r26/candidate/${issue1.sessionId}`
        : null,
    );
    const createdSessionId = issue1.sessionId;

    const issuedScenario = await admin.query(
      'SELECT scenario_snapshot::jsonb AS scenario_snapshot FROM hirearchy.assessment_sessions WHERE id = $1',
      [createdSessionId],
    );
    assert.equal(issuedScenario.rowCount, 1);
    assert.deepEqual(
      {
        id: issuedScenario.rows[0].scenario_snapshot?.scenario?.id,
        version: issuedScenario.rows[0].scenario_snapshot?.scenario?.version,
        title: issuedScenario.rows[0].scenario_snapshot?.scenario?.title,
        filePath: issuedScenario.rows[0].scenario_snapshot?.scenario?.filePath,
      },
      {
        id: 'scenario-002-booking-notification-retry',
        version: '1.0.0',
        title: 'The second confirmation',
        filePath: 'bookings/service.py',
      },
      'Issuance stores the server-selected immutable scenario snapshot',
    );

    // 6. Idempotent Replay (Case B: Same key, same intent)
    const issueReplay = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      {
        method: 'POST',
        cookies: jarRecruiterA,
        headers: {
          Origin: origin,
          'x-csrf-token': jarRecruiterA[csrfCookie],
        },
        body: {
          idempotencyKey: idempotencyKey1,
          scenarioId: 'scenario-002-booking-notification-retry',
          durationMinutes: 60,
        },
      },
    );
    assert.equal(issueReplay.status, 200, 'Replay returns 200 OK');
    const replayBody = JSON.parse(issueReplay.text);
    assert.equal(
      replayBody.sessionId,
      createdSessionId,
      'Replay returns identical sessionId',
    );
    assert.equal(replayBody.isReplay, true, 'isReplay flag is true');

    // 7. Idempotency Conflict (Case C: Same key, different intent)
    const issueConflict = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      {
        method: 'POST',
        cookies: jarRecruiterA,
        headers: {
          Origin: origin,
          'x-csrf-token': jarRecruiterA[csrfCookie],
        },
        body: {
          idempotencyKey: idempotencyKey1,
          scenarioId: 'scenario-002-booking-notification-retry',
          durationMinutes: 120, // Different duration!
        },
      },
    );
    assert.equal(
      issueConflict.status,
      409,
      'Changed intent with same key returns 409 Conflict',
    );
    const conflictBody = JSON.parse(issueConflict.text);
    assert.equal(conflictBody.error?.code, 'IDEMPOTENCY_KEY_CONFLICT');

    const replayWithChangedIntent = (changes, cookies = jarRecruiterA) =>
      request(origin, `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`, {
        method: 'POST',
        cookies,
        headers: {
          Origin: origin,
          'x-csrf-token': cookies[csrfCookie],
        },
        body: {
          idempotencyKey: idempotencyKey1,
          scenarioId: 'scenario-002-booking-notification-retry',
          durationMinutes: 60,
          ...changes,
        },
      });

    for (const [label, changes] of [
      ['scenario version', { scenarioVersion: '99.0.0' }],
      ['scenario title', { scenarioTitle: 'Untrusted replacement title' }],
      ['terminal capability', { terminalEnabled: false }],
      [
        'task rubric weights',
        {
          rubricWeights: {
            'problem-approach': 19,
            'implementation-quality': 26,
            'task-behavior': 25,
            'relevant-verification': 20,
            'recorded-integrated-ai-collaboration': 10,
          },
        },
      ],
      ['integrated AI capability', { integratedAi: true }],
    ]) {
      const changedReplay = await replayWithChangedIntent(changes);
      assert.equal(
        changedReplay.status,
        409,
        `Changed ${label} on an existing key must conflict`,
      );
      assert.equal(
        JSON.parse(changedReplay.text).error?.code,
        'IDEMPOTENCY_KEY_CONFLICT',
      );
      assert.doesNotMatch(
        changedReplay.text,
        new RegExp(createdSessionId),
        'Conflict must not disclose the original session ID',
      );
    }

    for (const [label, changes] of [
      ['unknown scenario', { scenarioId: 'scenario-not-supported' }],
      ['unsupported scenario version', { scenarioVersion: '99.0.0' }],
      ['mismatched scenario title', { scenarioTitle: 'Untrusted title' }],
    ]) {
      const rejected = await request(
        origin,
        `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
        {
          method: 'POST',
          cookies: jarRecruiterA,
          headers: {
            Origin: origin,
            'x-csrf-token': jarRecruiterA[csrfCookie],
          },
          body: {
            idempotencyKey: `invalid-${label.replaceAll(' ', '-')}-${Date.now()}`,
            scenarioId: 'scenario-002-booking-notification-retry',
            durationMinutes: 60,
            ...changes,
          },
        },
      );
      assert.equal(rejected.status, 400, `${label} must fail closed`);
      const rejectedBody = JSON.parse(rejected.text);
      assert.equal(rejectedBody.sessionId, undefined);
      assertNoCandidateBearer(rejected, `Rejected ${label}`);
    }

    const unsupportedAiIssue = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      {
        method: 'POST',
        cookies: jarRecruiterA,
        headers: {
          Origin: origin,
          'x-csrf-token': jarRecruiterA[csrfCookie],
        },
        body: {
          idempotencyKey: `unsupported-ai-${Date.now()}`,
          scenarioId: 'scenario-002-booking-notification-retry',
          durationMinutes: 60,
          integratedAi: true,
        },
      },
    );
    assert.equal(unsupportedAiIssue.status, 409);
    assert.equal(
      JSON.parse(unsupportedAiIssue.text).error?.code,
      'ASSESSMENT_CAPABILITY_UNSUPPORTED',
    );
    assertNoCandidateBearer(unsupportedAiIssue, 'Unsupported integrated AI');

    const otherIssuerReplay = await replayWithChangedIntent({}, jarRecruiterA2);
    assert.equal(otherIssuerReplay.status, 403);
    assert.doesNotMatch(
      otherIssuerReplay.text,
      new RegExp(createdSessionId),
      'A different issuer must not learn the existing session ID',
    );

    // 8. Cross-Organization Isolation (Case D: Same key in Org B)
    const issueOrgB = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgB}/sessions`,
      {
        method: 'POST',
        cookies: jarRecruiterB,
        headers: {
          Origin: origin,
          'x-csrf-token': jarRecruiterB[csrfCookie],
        },
        body: {
          idempotencyKey: idempotencyKey1, // Reused in Org B
          scenarioId: 'scenario-002-booking-notification-retry',
          durationMinutes: 60,
        },
      },
    );
    assert.equal(
      issueOrgB.status,
      201,
      'Same idempotency key in Org B succeeds independently',
    );
    const orgBBody = JSON.parse(issueOrgB.text);
    assert.notEqual(
      orgBBody.sessionId,
      createdSessionId,
      'Org B session is distinct',
    );
    assert.equal(orgBBody.organizationId, FIXTURE_IDS.orgB);

    // 9. Concurrent Duplicate Requests (Case E: 5 simultaneous requests)
    const concurrentKey = `key-concurrent-${Date.now()}`;
    const concurrentPromises = Array.from({ length: 5 }, () =>
      request(origin, `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`, {
        method: 'POST',
        cookies: jarRecruiterA,
        headers: {
          Origin: origin,
          'x-csrf-token': jarRecruiterA[csrfCookie],
        },
        body: {
          idempotencyKey: concurrentKey,
          scenarioId: 'scenario-002-booking-notification-retry',
          durationMinutes: 60,
        },
      }),
    );
    const concurrentResponses = await Promise.all(concurrentPromises);
    const sessionIds = [];
    for (const resp of concurrentResponses) {
      assert.ok(
        [200, 201].includes(resp.status),
        'Concurrent requests return 200 or 201',
      );
      const body = JSON.parse(resp.text);
      sessionIds.push(body.sessionId);
    }
    const uniqueSessionIds = new Set(sessionIds);
    assert.equal(
      uniqueSessionIds.size,
      1,
      'All concurrent duplicate requests must converge on exactly one session ID',
    );

    // 10. Role and Tenant Authorization Denials on Issuance
    // Recruiter A in Org B -> 403
    const crossOrgIssue = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgB}/sessions`,
      {
        method: 'POST',
        cookies: jarRecruiterA,
        headers: {
          Origin: origin,
          'x-csrf-token': jarRecruiterA[csrfCookie],
        },
        body: { scenarioId: 'scenario-002-booking-notification-retry' },
      },
    );
    assert.equal(
      crossOrgIssue.status,
      403,
      'Cross-org issuance denied with 403',
    );

    // Reviewer AB in Org A -> 403
    const reviewerIssue = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      {
        method: 'POST',
        cookies: jarReviewerAB,
        headers: {
          Origin: origin,
          'x-csrf-token': jarReviewerAB[csrfCookie],
        },
        body: { scenarioId: 'scenario-002-booking-notification-retry' },
      },
    );
    assert.equal(
      reviewerIssue.status,
      403,
      'Reviewer issuance denied with 403',
    );

    // Admin A in Org A -> 403
    const adminIssue = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      {
        method: 'POST',
        cookies: jarAdminA,
        headers: {
          Origin: origin,
          'x-csrf-token': jarAdminA[csrfCookie],
        },
        body: { scenarioId: 'scenario-002-booking-notification-retry' },
      },
    );
    assert.equal(adminIssue.status, 403, 'Admin issuance denied with 403');

    // 11. Candidate Token Recovery
    // Authorized issuer Recruiter A recovers token for createdSessionId
    const recoverRes = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${createdSessionId}/candidate-token`,
      {
        cookies: jarRecruiterA,
      },
    );
    assert.equal(recoverRes.status, 200, 'Authorized recovery returns 200');
    assertPrivateNoStore(recoverRes, 'Candidate token recovery');
    const recoverBody = JSON.parse(recoverRes.text);
    assert.ok(recoverBody.candidateToken, 'Returns candidate token string');
    assert.match(
      recoverBody.candidateToken,
      /^[A-Za-z0-9_-]{43}$/,
      'Candidate token keeps the SQLite 32-byte base64url format',
    );
    assert.equal(
      Buffer.from(recoverBody.candidateToken, 'base64url').length,
      32,
      'Candidate bearer uses 32 random bytes',
    );
    assert.equal(
      Object.hasOwn(recoverBody, 'candidateTokenHash'),
      false,
      'Recovery must not expose the internal candidate token hash',
    );
    const calculatedHash = createHash('sha256')
      .update(recoverBody.candidateToken)
      .digest('hex');
    const storedTokenHash = await admin.query(
      'SELECT candidate_token_hash FROM hirearchy.candidate_token_envelopes WHERE session_id = $1',
      [createdSessionId],
    );
    assert.equal(storedTokenHash.rowCount, 1);
    assert.equal(
      calculatedHash,
      storedTokenHash.rows[0].candidate_token_hash,
      'Recovered bearer must match the hash stored by the server',
    );
    assert.equal(
      recoverBody.candidateBearerAvailabilityStatus,
      extraEnv.HIREARCHY_R26_DISPOSABLE === '1'
        ? 'isolated_editing_only'
        : 'runtime_not_activated',
    );
    assert.ok(
      extraEnv.HIREARCHY_R26_DISPOSABLE === '1'
        ? recoverBody.notice.includes('isolated editing')
        : recoverBody.notice.includes('not activated'),
      'Includes truthful unmigrated runtime notice',
    );

    // Unauthorized Token Recovery:
    // Peer recruiter A2 -> 403 / 404
    const peerRecover = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${createdSessionId}/candidate-token`,
      {
        cookies: jarRecruiterA2,
      },
    );
    assert.ok(
      [403, 404].includes(peerRecover.status),
      'Peer recruiter cannot recover another recruiter session token',
    );

    // Reviewer AB -> 403
    const reviewerRecover = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${createdSessionId}/candidate-token`,
      {
        cookies: jarReviewerAB,
      },
    );
    assert.equal(
      reviewerRecover.status,
      403,
      'Reviewer cannot recover candidate token',
    );

    // Admin A -> 403
    const adminRecover = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${createdSessionId}/candidate-token`,
      {
        cookies: jarAdminA,
      },
    );
    assert.equal(
      adminRecover.status,
      403,
      'Admin cannot recover candidate token',
    );

    // 12. Reviewer Management: Eligible Reviewers List
    const unauthenticatedReviewers = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/reviewers`,
    );
    assert.equal(unauthenticatedReviewers.status, 401);

    const reviewerCannotListRecruiters = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/reviewers`,
      { cookies: jarReviewerAB },
    );
    assert.equal(reviewerCannotListRecruiters.status, 403);

    const crossOrgReviewerList = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgB}/reviewers`,
      { cookies: jarRecruiterA },
    );
    assert.equal(crossOrgReviewerList.status, 403);

    const reviewersRes = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/reviewers`,
      {
        cookies: jarRecruiterA,
      },
    );
    assert.equal(reviewersRes.status, 200);
    const reviewersList = JSON.parse(reviewersRes.text);
    assert.ok(Array.isArray(reviewersList.reviewers));
    assert.doesNotMatch(reviewersRes.text, /@reviewer\.test/i);
    assert.ok(
      reviewersList.reviewers.every(
        (reviewer) => reviewer.email === undefined || reviewer.email === null,
      ),
      'Reviewer listing must not invent an email address',
    );
    assert.ok(
      reviewersList.reviewers.some(
        (r) => r.principalId === FIXTURE_IDS.userAB.principalId,
      ),
      'User AB listed as eligible reviewer in Org A',
    );

    // 13. Reviewer Assignment
    const assignRes = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${createdSessionId}/assignments`,
      {
        method: 'POST',
        cookies: jarRecruiterA,
        headers: {
          Origin: origin,
          'x-csrf-token': jarRecruiterA[csrfCookie],
        },
        body: {
          reviewerPrincipalId: FIXTURE_IDS.userAB.principalId,
        },
      },
    );
    assert.equal(
      assignRes.status,
      201,
      'Assigning reviewer returns 201 Created',
    );
    const assignBody = JSON.parse(assignRes.text);
    assert.ok(assignBody.assignmentId);
    assert.equal(
      assignBody.reviewerPrincipalId,
      FIXTURE_IDS.userAB.principalId,
    );
    assert.equal(assignBody.revokedAt, null);
    const activeAssignmentId = assignBody.assignmentId;

    // Duplicate active assignment retry -> 200 OK (idempotent)
    const assignDupRes = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${createdSessionId}/assignments`,
      {
        method: 'POST',
        cookies: jarRecruiterA,
        headers: {
          Origin: origin,
          'x-csrf-token': jarRecruiterA[csrfCookie],
        },
        body: {
          reviewerPrincipalId: FIXTURE_IDS.userAB.principalId,
        },
      },
    );
    assert.equal(
      assignDupRes.status,
      200,
      'Duplicate active assignment returns 200',
    );
    const dupBody = JSON.parse(assignDupRes.text);
    assert.equal(dupBody.assignmentId, activeAssignmentId);

    // Assigning non-member / foreign org reviewer (User B) -> 400 / 403
    const foreignAssign = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${createdSessionId}/assignments`,
      {
        method: 'POST',
        cookies: jarRecruiterA,
        headers: {
          Origin: origin,
          'x-csrf-token': jarRecruiterA[csrfCookie],
        },
        body: {
          reviewerPrincipalId: FIXTURE_IDS.userB.principalId, // Member of Org B, not Org A!
        },
      },
    );
    assert.ok(
      [400, 403].includes(foreignAssign.status),
      'Assigning foreign org member must fail',
    );

    // Assigning revoked member -> 400 / 403
    const revokedAssign = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${createdSessionId}/assignments`,
      {
        method: 'POST',
        cookies: jarRecruiterA,
        headers: {
          Origin: origin,
          'x-csrf-token': jarRecruiterA[csrfCookie],
        },
        body: {
          reviewerPrincipalId: FIXTURE_IDS.userRevoked.principalId,
        },
      },
    );
    assert.ok(
      [400, 403].includes(revokedAssign.status),
      'Assigning revoked member must fail',
    );

    // 14. Reviewer Assignment Revocation
    const revokeRes = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${createdSessionId}/assignments/${activeAssignmentId}/revoke`,
      {
        method: 'POST',
        cookies: jarRecruiterA,
        headers: {
          Origin: origin,
          'x-csrf-token': jarRecruiterA[csrfCookie],
        },
      },
    );
    assert.equal(revokeRes.status, 200, 'Revocation returns 200 OK');
    const revokeBody = JSON.parse(revokeRes.text);
    assert.equal(revokeBody.revoked, true);

    // Revocation retry (safe idempotent)
    const revokeRetryRes = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${createdSessionId}/assignments/${activeAssignmentId}/revoke`,
      {
        method: 'POST',
        cookies: jarRecruiterA,
        headers: {
          Origin: origin,
          'x-csrf-token': jarRecruiterA[csrfCookie],
        },
      },
    );
    assert.equal(revokeRetryRes.status, 200, 'Revocation retry returns 200 OK');

    // 15. Real HTTPS Browser Acceptance Journey
    await runR25BrowserIssuanceChecks({
      origin,
      users,
      evidence,
      admin,
      candidateLaneEnabled: extraEnv.HIREARCHY_R26_DISPOSABLE === '1',
    });

    // Successful empty reviewer results stay distinct from lookup failures.
    const activeReviewerMemberships = await admin.query(
      `SELECT principal_id FROM hirearchy.organization_memberships
       WHERE organization_id = $1 AND role = 'reviewer'
         AND status = 'active' AND revoked_at IS NULL`,
      [FIXTURE_IDS.orgA],
    );
    assert.ok(activeReviewerMemberships.rowCount > 0);
    try {
      await admin.query(
        `UPDATE hirearchy.organization_memberships SET role = 'admin'
         WHERE organization_id = $1 AND role = 'reviewer'
           AND status = 'active' AND revoked_at IS NULL`,
        [FIXTURE_IDS.orgA],
      );
      const emptyReviewers = await request(
        origin,
        `/r23/api/organizations/${FIXTURE_IDS.orgA}/reviewers`,
        { cookies: jarRecruiterA },
      );
      assert.equal(emptyReviewers.status, 200);
      assert.deepEqual(JSON.parse(emptyReviewers.text).reviewers, []);
    } finally {
      for (const {
        principal_id: principalId,
      } of activeReviewerMemberships.rows) {
        await admin.query(
          `UPDATE hirearchy.organization_memberships SET role = 'reviewer'
           WHERE organization_id = $1 AND principal_id = $2`,
          [FIXTURE_IDS.orgA, principalId],
        );
      }
    }

    // A query failure is a sanitized unavailable response, never an empty list.
    await admin.query(
      'ALTER FUNCTION r25.list_organization_reviewers(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) RENAME TO list_organization_reviewers_unavailable',
    );
    try {
      const reviewerQueryFailure = await request(
        origin,
        `/r23/api/organizations/${FIXTURE_IDS.orgA}/reviewers`,
        { cookies: jarRecruiterA, headers: { Accept: 'application/json' } },
      );
      assert.equal(reviewerQueryFailure.status, 503);
      assert.doesNotMatch(
        reviewerQueryFailure.text,
        /does not exist|permission denied|42883|list_organization_reviewers/i,
        'Database errors must not escape in the reviewer response',
      );
      const reviewerFailureBody = JSON.parse(reviewerQueryFailure.text);
      assert.ok(reviewerFailureBody.error);
      assert.equal(Object.hasOwn(reviewerFailureBody, 'reviewers'), false);

      const summaryReviewerFailure = await request(
        origin,
        `/r23/organizations/${FIXTURE_IDS.orgA}/sessions/${createdSessionId}`,
        { cookies: jarRecruiterA },
      );
      assert.equal(
        summaryReviewerFailure.status,
        503,
        'Session summary must fail closed when reviewer lookup fails',
      );
      assert.doesNotMatch(
        summaryReviewerFailure.text,
        /does not exist|permission denied|42883|list_organization_reviewers/i,
        'Session summary must not expose database details',
      );
      assert.doesNotMatch(
        summaryReviewerFailure.text,
        /No reviewers currently assigned|Select an eligible reviewer/i,
        'Session summary must not render a false empty reviewer state',
      );
    } finally {
      await admin.query(
        'ALTER FUNCTION r25.list_organization_reviewers_unavailable(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) RENAME TO list_organization_reviewers',
      );
    }

    const markerBeforeWrongKey = await admin.query(
      'SELECT version, database_id, key_check FROM hirearchy.candidate_token_storage_meta WHERE slot = 1',
    );
    const wrongKey = randomBytes(32).toString('base64');
    await stop();
    await start({ HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY: wrongKey });

    const wrongKeyFreshKey = `wrong-key-fresh-${Date.now()}`;
    const wrongKeyFreshIssue = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      {
        method: 'POST',
        cookies: jarRecruiterA,
        headers: {
          Origin: origin,
          'x-csrf-token': jarRecruiterA[csrfCookie],
        },
        body: {
          idempotencyKey: wrongKeyFreshKey,
          scenarioId: 'scenario-002-booking-notification-retry',
          durationMinutes: 60,
        },
      },
    );
    assert.equal(wrongKeyFreshIssue.status, 503);
    assertNoCandidateBearer(wrongKeyFreshIssue, 'Wrong-key fresh issuance');
    const failedWrongKeyIssuance = await admin.query(
      'SELECT 1 FROM hirearchy.assessment_issuances WHERE organization_id = $1 AND idempotency_key = $2',
      [FIXTURE_IDS.orgA, wrongKeyFreshKey],
    );
    assert.equal(failedWrongKeyIssuance.rowCount, 0);

    const wrongKeyReplay = await replayWithChangedIntent({});
    assert.equal(wrongKeyReplay.status, 503);
    assertNoCandidateBearer(wrongKeyReplay, 'Wrong-key issuance replay');
    assert.doesNotMatch(wrongKeyReplay.text, new RegExp(createdSessionId));

    const wrongKeyRecovery = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${createdSessionId}/candidate-token`,
      {
        cookies: jarRecruiterA,
        headers: { Accept: 'application/json' },
      },
    );
    assert.equal(wrongKeyRecovery.status, 503);
    assertNoCandidateBearer(
      wrongKeyRecovery,
      'Wrong-key candidate recovery',
      recoverBody.candidateToken,
    );

    await stop();
    await start({ HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY: '' });
    const missingKeyIssue = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      {
        method: 'POST',
        cookies: jarRecruiterA,
        headers: {
          Origin: origin,
          'x-csrf-token': jarRecruiterA[csrfCookie],
        },
        body: {
          idempotencyKey: `missing-key-${Date.now()}`,
          scenarioId: 'scenario-002-booking-notification-retry',
          durationMinutes: 60,
        },
      },
    );
    assert.equal(missingKeyIssue.status, 503);
    assertNoCandidateBearer(missingKeyIssue, 'Missing-key issuance');
    const missingKeyRecovery = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${createdSessionId}/candidate-token`,
      {
        cookies: jarRecruiterA,
        headers: { Accept: 'application/json' },
      },
    );
    assert.equal(missingKeyRecovery.status, 503);
    assertNoCandidateBearer(
      missingKeyRecovery,
      'Missing-key candidate recovery',
      recoverBody.candidateToken,
    );

    await stop();
    await start();
    const originalStorageMarker = await admin.query(
      'SELECT version, database_id, key_check FROM hirearchy.candidate_token_storage_meta WHERE slot = 1',
    );
    assert.equal(originalStorageMarker.rowCount, 1);
    const tamperedDatabaseId = randomBytes(16).toString('base64url');
    await admin.query(
      'UPDATE hirearchy.candidate_token_storage_meta SET database_id = $1 WHERE slot = 1',
      [tamperedDatabaseId],
    );
    try {
      const mismatchIssueKey = `database-id-mismatch-${Date.now()}`;
      const mismatchIssue = await request(
        origin,
        `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
        {
          method: 'POST',
          cookies: jarRecruiterA,
          headers: {
            Origin: origin,
            'x-csrf-token': jarRecruiterA[csrfCookie],
          },
          body: {
            idempotencyKey: mismatchIssueKey,
            scenarioId: 'scenario-002-booking-notification-retry',
            durationMinutes: 60,
          },
        },
      );
      assert.equal(mismatchIssue.status, 503);
      assertNoCandidateBearer(
        mismatchIssue,
        'Mismatched database identity issuance',
      );
      const failedMismatchIssuance = await admin.query(
        'SELECT 1 FROM hirearchy.assessment_issuances WHERE organization_id = $1 AND idempotency_key = $2',
        [FIXTURE_IDS.orgA, mismatchIssueKey],
      );
      assert.equal(failedMismatchIssuance.rowCount, 0);

      const mismatchRecovery = await request(
        origin,
        `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${createdSessionId}/candidate-token`,
        {
          cookies: jarRecruiterA,
          headers: { Accept: 'application/json' },
        },
      );
      assert.equal(mismatchRecovery.status, 503);
      assertNoCandidateBearer(
        mismatchRecovery,
        'Mismatched database identity recovery',
        recoverBody.candidateToken,
      );

      const afterMismatch = await admin.query(
        'SELECT version, database_id, key_check FROM hirearchy.candidate_token_storage_meta WHERE slot = 1',
      );
      assert.deepEqual(
        afterMismatch.rows,
        [
          {
            ...originalStorageMarker.rows[0],
            database_id: tamperedDatabaseId,
          },
        ],
        'Issuance and recovery must not repair or replace a mismatched database identity',
      );
    } finally {
      await admin.query(
        'UPDATE hirearchy.candidate_token_storage_meta SET version = $1, database_id = $2, key_check = $3 WHERE slot = 1',
        [
          originalStorageMarker.rows[0].version,
          originalStorageMarker.rows[0].database_id,
          originalStorageMarker.rows[0].key_check,
        ],
      );
    }

    const originalEnvelope = await admin.query(
      'SELECT candidate_token_ciphertext FROM hirearchy.candidate_token_envelopes WHERE session_id = $1',
      [createdSessionId],
    );
    assert.equal(originalEnvelope.rowCount, 1);
    const originalCiphertext =
      originalEnvelope.rows[0].candidate_token_ciphertext;
    const keyBytes = Buffer.from(candidateTokenKey, 'base64');

    for (const [label, ciphertext] of [
      ['tampered ciphertext', 'v1.invalid.invalid.invalid'],
      [
        'wrong authenticated session data',
        encryptCandidateToken(
          'unreturned-test-token',
          'different-associated-session',
          keyBytes,
        ),
      ],
    ]) {
      await admin.query(
        'ALTER TABLE hirearchy.candidate_token_envelopes DISABLE TRIGGER USER',
      );
      try {
        await admin.query(
          'UPDATE hirearchy.candidate_token_envelopes SET candidate_token_ciphertext = $1 WHERE session_id = $2',
          [ciphertext, createdSessionId],
        );
        const tamperedRecovery = await request(
          origin,
          `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${createdSessionId}/candidate-token`,
          {
            cookies: jarRecruiterA,
            headers: { Accept: 'application/json' },
          },
        );
        assert.equal(tamperedRecovery.status, 503, `${label} must fail closed`);
        assertNoCandidateBearer(
          tamperedRecovery,
          `Recovery with ${label}`,
          recoverBody.candidateToken,
        );
      } finally {
        await admin.query(
          'UPDATE hirearchy.candidate_token_envelopes SET candidate_token_ciphertext = $1 WHERE session_id = $2',
          [originalCiphertext, createdSessionId],
        );
        await admin.query(
          'ALTER TABLE hirearchy.candidate_token_envelopes ENABLE TRIGGER USER',
        );
      }
    }

    const markerAfterWrongKey = await admin.query(
      'SELECT version, database_id, key_check FROM hirearchy.candidate_token_storage_meta WHERE slot = 1',
    );
    assert.deepEqual(
      markerAfterWrongKey.rows,
      markerBeforeWrongKey.rows,
      'Wrong or missing keys must not rewrite the database binding',
    );
    if (candidateChecks) {
      await candidateChecks({
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
      });
    }
    console.log(
      'PASS R2.5 HTTPS Browser Acceptance Journey: assessment issuance, idempotency, original-token recovery, reviewer assignment and revocation',
    );
  } finally {
    await stop();
  }
}
