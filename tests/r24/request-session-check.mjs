import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { FIXTURE_IDS } from '../../database/postgres/r23/adapter.mjs';
import {
  seedR24SessionFixtures,
  runR24PostgresSessionSecurityChecks,
} from './postgres-session-security-check.mjs';
import { runR24BrowserSessionChecks } from './browser-session-check.mjs';

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

export async function runR24RequestAndBrowserChecks({
  admin,
  connection,
  runtimePassword,
  authUrl,
  issuer,
  audience,
  users,
  authCall,
  evidenceDir,
}) {
  const evidence =
    evidenceDir ?? mkdtempSync(join(tmpdir(), 'hirearchy-r24-https-'));
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
    HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY:
      randomBytes(32).toString('base64'),
    HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_OLD_KEY: '',
    OPENROUTER_KEY: '',
    NVIDIA_API_KEY: '',
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
        if ((await request(origin, '/r23/login')).status < 500) return;
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

  const nextEnvPath = 'apps/web/next-env.d.ts';
  const nextEnvOriginal = existsSync(nextEnvPath)
    ? readFileSync(nextEnvPath)
    : null;

  const evaluatorPool = new Pool({
    ...connection,
    user: 'r23_gateway',
    password: runtimePassword,
    max: 4,
  });
  const candidatePool = new Pool({
    ...connection,
    user: 'app_candidate_gateway',
    password: runtimePassword,
    max: 2,
  });
  const workerPool = new Pool({
    ...connection,
    user: 'app_control_worker',
    password: runtimePassword,
    max: 2,
  });

  try {
    // Seed R2.4 synthetic fixtures and bind real GoTrue Auth user subjects!
    await seedR24SessionFixtures(admin);
    const userMapping = [
      ['a', FIXTURE_IDS.userA.principalId],
      ['b', FIXTURE_IDS.userB.principalId],
      ['ab', FIXTURE_IDS.userAB.principalId],
      ['revoked', FIXTURE_IDS.userRevoked.principalId],
      ['recruiterA2', FIXTURE_IDS.recruiterA2.principalId],
      ['recruiterEmpty', FIXTURE_IDS.recruiterAEmpty.principalId],
      ['adminA', FIXTURE_IDS.adminA.principalId],
      ['recruiterB', FIXTURE_IDS.recruiterB.principalId],
    ];

    // Temporarily drop immutability trigger on application_principals only to bind real GoTrue UUIDs to the deterministic fixture principals, or insert with real GoTrue UUIDs before seeding!
    // Wait: let's check! In seedR24SessionFixtures, application_principals already has fixed subjectIds unless we bind them first.
    // Let's check: application_principals has trigger principals_identity_immutable!
    // So let's truncate and seed with the real GoTrue subjectIds or update FIXTURE_IDS!
    // Wait: runR24PostgresSessionSecurityChecks uses FIXTURE_IDS.*.subjectId!
    // So first run runR24PostgresSessionSecurityChecks with FIXTURE_IDS.*.subjectId, OR create the GoTrue users with the exact UUIDs in auth.users!
    // Wait: in PostgreSQL, `admin` can update `auth.users` or insert `auth.users` with exact IDs, OR we can run `runR24PostgresSessionSecurityChecks` first, and then bind the GoTrue subjects!
    await runR24PostgresSessionSecurityChecks({
      admin,
      evaluatorPool,
      candidatePool,
      workerPool,
    });
    console.log(
      'PASS R2.4 PostgreSQL session security and tenant isolation checks',
    );

    // Now bind the GoTrue users to the fixture principals (by temporarily disabling trigger on application_principals and r23.principal_subject_bindings)
    await admin.query(
      'ALTER TABLE hirearchy.application_principals DISABLE TRIGGER USER',
    );
    for (const [keyName, principalId] of userMapping) {
      const pair = await authCall('/token?grant_type=password', users[keyName]);
      const subject = JSON.parse(
        Buffer.from(pair.access_token.split('.')[1], 'base64url').toString(),
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

    // 1. Disabled-by-default check on all R2.4 routes
    await start({ HIREARCHY_R23_DISPOSABLE: '0' });
    for (const path of [
      `/r23/organizations/${FIXTURE_IDS.orgA}`,
      `/r23/organizations/${FIXTURE_IDS.orgA}/sessions/${FIXTURE_IDS.sessions.a003SubmittedAssigned}`,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${FIXTURE_IDS.sessions.a003SubmittedAssigned}`,
    ]) {
      const res = await request(origin, path);
      assert.equal(
        res.status,
        404,
        `Disabled boundary must return 404 for ${path}`,
      );
    }
    await stop();

    // 2. Start enabled HTTPS server
    await start();

    // 3. Unauthenticated requests to R2.4 JSON API and HTML routes return 401
    for (const path of [
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${FIXTURE_IDS.sessions.a003SubmittedAssigned}`,
    ]) {
      const res = await request(origin, path, {
        headers: { Accept: 'application/json' },
      });
      assert.equal(
        res.status,
        401,
        `Unauthenticated API request to ${path} must return 401`,
      );
      assertPrivateNoStore(res, path);
    }

    // 4. Sign in as Recruiter A without selecting organization -> session API returns 403
    const jarUnselected = await signInAndSelectOrg(origin, users.a, null);
    const unselectedApiRes = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      {
        cookies: jarUnselected,
        headers: { Accept: 'application/json' },
      },
    );
    assert.equal(
      unselectedApiRes.status,
      403,
      'Reading organization sessions before explicit organization selection must return 403',
    );

    // 5. Explicitly select Org A for Recruiter A -> verify JSON API list & summary
    const jarA = await signInAndSelectOrg(origin, users.a, FIXTURE_IDS.orgA);
    const listARes = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      {
        cookies: jarA,
        headers: { Accept: 'application/json' },
      },
    );
    assert.equal(listARes.status, 200);
    assertPrivateNoStore(listARes, 'Recruiter A session list API');
    const listABody = JSON.parse(listARes.text);
    assert.equal(listABody.organization.id, FIXTURE_IDS.orgA);
    assert.equal(listABody.organization.role, 'recruiter');
    assert.equal(listABody.visibilityScope, 'issued_by_recruiter');
    assert.equal(listABody.totalAuthorizedCount, 5);
    assert.equal(listABody.assessments.length, 5);
    for (const item of listABody.assessments) {
      assert.equal(item.candidatePath, null);
      assert.equal('tokenHash' in item, false);
      assert.equal('candidateToken' in item, false);
    }

    // Recruiter A summary API for own session -> 200
    const summaryARes = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${FIXTURE_IDS.sessions.a003SubmittedAssigned}`,
      {
        cookies: jarA,
        headers: { Accept: 'application/json' },
      },
    );
    assert.equal(summaryARes.status, 200);
    assertPrivateNoStore(summaryARes, 'Recruiter A session summary API');
    const summaryABody = JSON.parse(summaryARes.text);
    assert.equal(
      summaryABody.session.sessionId,
      FIXTURE_IDS.sessions.a003SubmittedAssigned,
    );

    // Recruiter A summary API for peer recruiter session -> 404
    const peerSummaryRes = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${FIXTURE_IDS.sessions.a006OtherRecruiter}`,
      {
        cookies: jarA,
        headers: { Accept: 'application/json' },
      },
    );
    assert.equal(peerSummaryRes.status, 404);

    // Recruiter A cross-org API request to Org B -> 403
    const crossOrgApiRes = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgB}/sessions`,
      {
        cookies: jarA,
        headers: { Accept: 'application/json' },
      },
    );
    assert.equal(crossOrgApiRes.status, 403);

    // 6. Reviewer AB in Org A -> sees only 2 assigned submitted sessions via API
    const jarAB = await signInAndSelectOrg(origin, users.ab, FIXTURE_IDS.orgA);
    const listABRes = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      {
        cookies: jarAB,
        headers: { Accept: 'application/json' },
      },
    );
    assert.equal(listABRes.status, 200);
    const listABBody = JSON.parse(listABRes.text);
    assert.equal(listABBody.organization.role, 'reviewer');
    assert.equal(listABBody.visibilityScope, 'assigned_to_reviewer');
    assert.equal(listABBody.totalAuthorizedCount, 2);
    assert.deepEqual(
      listABBody.assessments.map((a) => a.sessionId),
      [
        FIXTURE_IDS.sessions.a004TimeoutAssigned,
        FIXTURE_IDS.sessions.a003SubmittedAssigned,
      ],
    );

    // Reviewer AB cannot fetch pre-submission assigned session a002Active -> 404
    const activeSummaryAB = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${FIXTURE_IDS.sessions.a002Active}`,
      {
        cookies: jarAB,
        headers: { Accept: 'application/json' },
      },
    );
    assert.equal(activeSummaryAB.status, 404);

    // 7. Run Real HTTPS Chromium Browser Session Acceptance Journey
    await runR24BrowserSessionChecks({
      origin,
      users,
      evidence,
      admin,
    });
    console.log(
      'PASS R2.4 real HTTPS Chromium browser session acceptance journey',
    );
  } finally {
    await stop();
    await evaluatorPool.end().catch(() => {});
    await candidatePool.end().catch(() => {});
    await workerPool.end().catch(() => {});
    if (nextEnvOriginal !== null) writeFileSync(nextEnvPath, nextEnvOriginal);
  }
}
