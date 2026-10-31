import assert from 'node:assert/strict';
import {
  randomBytes,
  randomUUID,
  createHash,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { runBrowserCheck } from './browser-check.mjs';
import { runR23MembershipChecks } from './membership-check.mjs';

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
        rejectUnauthorized: false, // Disposable self-signed loopback certificate only.
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
    assert.match(line, /;\s*Secure/i);
    assert.match(line, /;\s*Path=\//i);
    assert.match(line, /;\s*SameSite=Strict/i);
    assert.doesNotMatch(line, /;\s*Domain=/i);
  }
  return jar;
}

function noStore(response) {
  assert.match(response.headers['cache-control'] ?? '', /no-store/i);
  assert.doesNotMatch(
    response.headers['cache-control'] ?? '',
    /(?:public|s-maxage)/i,
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

async function authBarrierProxy(upstream) {
  let pending;
  let unavailable = false;
  const server = createHttpServer(async (req, res) => {
    try {
      if (unavailable) {
        res.writeHead(503);
        res.end('{}');
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const response = await fetch(new URL(req.url, upstream), {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          ...(req.headers.authorization
            ? { Authorization: req.headers.authorization }
            : {}),
        },
        ...(req.method === 'GET' ? {} : { body: Buffer.concat(chunks) }),
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      const body = Buffer.from(await response.arrayBuffer());
      if (pending && pending.path === req.url) {
        const barrier = pending;
        pending = undefined;
        barrier.reached();
        await barrier.wait;
      }
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch {
      res.writeHead(502);
      res.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    outage(value) {
      unavailable = value;
    },
    pause(path) {
      assert.equal(pending, undefined);
      let reached;
      let release;
      const reachedPromise = new Promise((resolve) => {
        reached = resolve;
      });
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      pending = { path, reached, wait, release };
      return { reached: reachedPromise, release };
    },
    async close() {
      pending?.release();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function runRequestChecks({
  admin,
  connection,
  runtimePassword,
  authUrl,
  issuer,
  audience,
  users,
  authCall,
}) {
  const evidence = mkdtempSync(join(tmpdir(), 'hirearchy-r23-https-'));
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
  const proxy = await authBarrierProxy(authUrl);
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    HIREARCHY_R23_DISPOSABLE: '1',
    R23_AUTH_URL: proxy.url,
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
        /* bounded readiness only */
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
  const pool = new Pool({
    ...connection,
    user: 'r23_gateway',
    password: runtimePassword,
    max: 1,
  });
  try {
    const orgA = randomUUID();
    const orgB = randomUUID();
    await admin.query(
      'INSERT INTO hirearchy.organizations(id) VALUES ($1),($2)',
      [orgA, orgB],
    );
    const principals = {};
    for (const [name, user] of Object.entries(users)) {
      const pair = await authCall('/token?grant_type=password', user);
      if (name === 'a')
        console.log('Auth protocol token sizes:', {
          access: pair.access_token.length,
          refresh: pair.refresh_token.length,
          expiresIn: pair.expires_in,
        });
      const subject = JSON.parse(
        Buffer.from(pair.access_token.split('.')[1], 'base64url').toString(),
      ).sub;
      principals[name] = randomUUID();
      await admin.query(
        'INSERT INTO hirearchy.application_principals(id,auth_user_id) VALUES($1,$2)',
        [principals[name], subject],
      );
      const orgs =
        name === 'ab'
          ? [orgA, orgB]
          : name === 'b'
            ? [orgB]
            : name === 'signup'
              ? []
              : [orgA];
      for (const org of orgs)
        await admin.query(
          `INSERT INTO hirearchy.organization_memberships(organization_id,principal_id,role,status,joined_at,revoked_at,version) VALUES($1,$2,'reviewer',$3,now(),$4,1)`,
          [
            org,
            principals[name],
            name === 'revoked' ? 'revoked' : 'active',
            name === 'revoked' ? new Date() : null,
          ],
        );
    }
    execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `import assert from 'node:assert/strict';
         process.env.NODE_ENV = 'production';
         process.env.HIREARCHY_R23_DISPOSABLE = '1';
         const mod = await import('./apps/web/src/r23-auth/config.ts');
         const cfg = mod.default ?? mod;
         assert.equal(cfg.r23IsEnabled(), false, 'r23IsEnabled must be false in production');
         assert.equal(cfg.readR23Config(), null, 'readR23Config must be null in production');`,
      ],
      { stdio: 'ignore' },
    );
    await start({ HIREARCHY_R23_DISPOSABLE: '0' });
    for (const [path, method] of [
      ['/r23/login', 'GET'],
      ['/r23/auth/login', 'POST'],
      ['/r23/auth/callback', 'GET'],
      ['/r23/organizations', 'GET'],
      ['/r23/organization', 'POST'],
      [`/r23/organizations/${orgA}`, 'GET'],
      ['/r23/auth/refresh', 'POST'],
      ['/r23/auth/logout', 'POST'],
    ]) {
      const res = await request(origin, path, { method });
      assert.equal(res.status, 404, `disabled boundary for ${method} ${path}`);
    }
    await stop();
    await start();
    console.log(`R2.3 HTTPS fixture evidence: ${evidence}`);
    await runR23MembershipChecks({
      admin,
      pool,
      organizations: { a: orgA, b: orgB },
      principals,
    });
    // Route-specific request and rendered-browser assertions follow below.
    await runJourney({
      origin,
      request,
      cookieJar,
      noStore,
      users,
      orgA,
      orgB,
      admin,
      pool,
      principals,
      stop,
      start,
      evidence,
      proxy,
      env,
      authUrl,
    });
    for (const file of existsSync('apps/web/.next/static')
      ? readdirSync('apps/web/.next/static', { recursive: true })
      : []) {
      if (!/\.(?:js|map)$/.test(file)) continue;
      const text = readFileSync(join('apps/web/.next/static', file), 'utf8');
      for (const secret of [runtimePassword, databaseUrl, env.R23_SESSION_KEY])
        assert(
          !text.includes(secret),
          'server credentials absent from browser bundle',
        );
    }
  } finally {
    await stop();
    await pool.end();
    await proxy.close();
    if (nextEnvOriginal !== null) writeFileSync(nextEnvPath, nextEnvOriginal);
  }
}

async function storedCredentials(admin, jar, key) {
  const hash = createHash('sha256').update(jar[sessionCookie]).digest('hex');
  const {
    rows: [row],
  } = await admin.query(
    'SELECT * FROM r23.server_sessions WHERE handle_hash=$1',
    [hash],
  );
  const envelope = row.credential_envelope;
  const aad = Buffer.from(
    `hirearchy-r23-auth-v1:${row.subject_id}:${row.auth_session_id}`,
  );
  const cipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'base64'),
    envelope.subarray(1, 13),
  );
  cipher.setAAD(aad);
  cipher.setAuthTag(envelope.subarray(13, 29));
  const pair = JSON.parse(
    Buffer.concat([
      cipher.update(envelope.subarray(29)),
      cipher.final(),
    ]).toString(),
  );
  return {
    pair,
    hash,
    async replace(nextPair) {
      const nonce = randomBytes(12);
      const encoder = createCipheriv(
        'aes-256-gcm',
        Buffer.from(key, 'base64'),
        nonce,
      );
      encoder.setAAD(aad);
      const ciphertext = Buffer.concat([
        encoder.update(JSON.stringify(nextPair)),
        encoder.final(),
      ]);
      const encoded = Buffer.concat([
        Buffer.from([1]),
        nonce,
        encoder.getAuthTag(),
        ciphertext,
      ]);
      await admin.query(
        'UPDATE r23.server_sessions SET credential_envelope=$1 WHERE handle_hash=$2',
        [encoded, hash],
      );
    },
  };
}

async function runJourney({
  origin,
  request,
  cookieJar,
  noStore,
  users,
  orgA,
  orgB,
  admin,
  pool,
  principals,
  stop,
  start,
  evidence,
  proxy,
  env,
  authUrl,
}) {
  const mutate = (path, jar, body = {}, headers = {}) =>
    request(origin, path, {
      method: 'POST',
      cookies: jar,
      body,
      headers: {
        Origin: origin,
        'X-CSRF-Token': jar[csrfCookie] ?? '',
        ...headers,
      },
    });
  const login = async (name) => {
    const response = await request(origin, '/r23/auth/login', {
      method: 'POST',
      body: users[name],
      headers: { Origin: origin },
    });
    assert.equal(response.status, 303, `login ${name}`);
    noStore(response);
    const jar = cookieJar(response);
    assert(jar[sessionCookie] && jar[csrfCookie] && jar['__Host-r23-callback']);
    assert.match(
      response.headers['set-cookie'].find((line) =>
        line.startsWith(sessionCookie + '='),
      ),
      /HttpOnly/i,
    );
    const pending = await request(origin, '/r23/organizations', {
      cookies: jar,
    });
    assert.notEqual(
      pending.status,
      200,
      'pending callback cannot bypass binding',
    );
    const wrong = await request(origin, '/r23/auth/callback', {
      cookies: {
        ...jar,
        '__Host-r23-callback': randomBytes(32).toString('base64url'),
      },
    });
    assert.equal(wrong.status, 401);
    const callback = await request(origin, '/r23/auth/callback', {
      cookies: jar,
    });
    assert.equal(callback.status, 303);
    noStore(callback);
    assert.equal(
      new URL(callback.headers.location, origin).pathname,
      '/r23/organizations',
    );
    const replay = await request(origin, '/r23/auth/callback', {
      cookies: jar,
    });
    assert.equal(replay.status, 401, 'callback replay denied');
    delete jar['__Host-r23-callback'];
    return jar;
  };
  for (const headers of [{}, { Origin: 'https://attacker.invalid' }]) {
    const response = await request(origin, '/r23/auth/login', {
      method: 'POST',
      body: users.a,
      headers,
    });
    assert.equal(response.status, 403);
    noStore(response);
    assert.equal(response.headers['set-cookie'], undefined);
  }
  const oversized = await request(origin, '/r23/auth/login', {
    method: 'POST',
    body: { email: 'x'.repeat(5000), password: 'x' },
    headers: { Origin: origin },
  });
  assert.equal(oversized.status, 413);
  const unsafeCallback = await request(
    origin,
    '/r23/auth/callback?access_token=forged',
  );
  assert([400, 401].includes(unsafeCallback.status));
  const anonymous = await request(origin, `/r23/organizations/${orgA}`);
  assert.equal(anonymous.status, 401);
  noStore(anonymous);
  assert(!anonymous.text.includes(orgA));
  const sessions = {};
  for (const name of ['a', 'b', 'ab', 'revoked', 'signup'])
    sessions[name] = await login(name);
  const selected = async (name, org) => {
    const result = await mutate('/r23/organization', sessions[name], {
      organizationId: org,
    });
    assert.equal(result.status, 303, `select ${name}`);
    noStore(result);
    assert.equal(
      new URL(result.headers.location, origin).pathname,
      `/r23/organizations/${org}`,
    );
    return request(origin, `/r23/organizations/${org}`, {
      cookies: sessions[name],
    });
  };
  for (const [name, own, foreign] of [
    ['a', orgA, orgB],
    ['b', orgB, orgA],
  ]) {
    const before = await request(origin, `/r23/organizations/${own}`, {
      cookies: sessions[name],
    });
    assert.equal(before.status, 403, 'explicit selection required');
    const list = await request(origin, '/r23/organizations', {
      cookies: sessions[name],
    });
    assert.equal(list.status, 200);
    noStore(list);
    assert(list.text.includes(own));
    assert(!list.text.includes(foreign));
    const allowed = await selected(name, own);
    assert.equal(allowed.status, 200);
    noStore(allowed);
    assert(allowed.text.includes(own));
    const denied = await request(origin, `/r23/organizations/${foreign}`, {
      cookies: sessions[name],
    });
    assert.equal(denied.status, 403);
    noStore(denied);
    assert(!denied.text.includes(foreign));
    assert.equal(
      (
        await mutate('/r23/organization', sessions[name], {
          organizationId: foreign,
        })
      ).status,
      403,
    );
  }
  const ab = sessions.ab;
  assert.equal(
    (await request(origin, `/r23/organizations/${orgA}`, { cookies: ab }))
      .status,
    403,
  );
  assert.equal((await selected('ab', orgA)).status, 200);
  assert.equal(
    (await request(origin, `/r23/organizations/${orgB}`, { cookies: ab }))
      .status,
    403,
  );
  assert.equal((await selected('ab', orgB)).status, 200);
  assert.equal(
    (await request(origin, `/r23/organizations/${orgA}`, { cookies: ab }))
      .status,
    403,
  );
  for (const name of ['revoked', 'signup'])
    assert.equal(
      (
        await mutate('/r23/organization', sessions[name], {
          organizationId: orgA,
        })
      ).status,
      403,
    );
  for (const org of ['not-a-uuid', "' OR TRUE --", randomUUID()]) {
    const response = await mutate('/r23/organization', sessions.a, {
      organizationId: org,
    });
    assert.equal(
      response.status,
      org.includes('-') && /^[a-f0-9-]{36}$/.test(org) ? 403 : 400,
    );
  }
  for (const path of [
    '/r23/organization',
    '/r23/auth/refresh',
    '/r23/auth/logout',
  ]) {
    for (const headers of [
      { Origin: '' },
      { Origin: 'https://attacker.invalid' },
      { 'X-CSRF-Token': '' },
      { 'X-CSRF-Token': sessions.b[csrfCookie] },
    ]) {
      const response = await mutate(
        path,
        sessions.a,
        path === '/r23/organization' ? { organizationId: orgA } : {},
        headers,
      );
      assert.equal(response.status, 403);
      noStore(response);
      if (path === '/r23/auth/logout') {
        assert.equal(
          response.headers['set-cookie'],
          undefined,
          'rejected logout requests do not clear browser cookies',
        );
      }
    }
  }
  const validCsrf = randomBytes(32).toString('base64url');
  const unauthLogout = await request(origin, '/r23/auth/logout', {
    method: 'POST',
    cookies: { [csrfCookie]: validCsrf },
    headers: {
      Origin: origin,
      'X-CSRF-Token': validCsrf,
    },
  });
  assert.equal(unauthLogout.status, 401);
  noStore(unauthLogout);
  assert.equal(
    unauthLogout.headers['set-cookie'],
    undefined,
    'unauthenticated logout does not clear cookies',
  );

  const invalidSessionLogout = await request(origin, '/r23/auth/logout', {
    method: 'POST',
    cookies: {
      [sessionCookie]: randomBytes(32).toString('base64url'),
      [csrfCookie]: validCsrf,
    },
    headers: {
      Origin: origin,
      'X-CSRF-Token': validCsrf,
    },
  });
  assert.equal(invalidSessionLogout.status, 401);
  noStore(invalidSessionLogout);
  assert.equal(
    invalidSessionLogout.headers['set-cookie'],
    undefined,
    'invalid session logout does not clear cookies',
  );
  const forged = await request(origin, `/r23/organizations/${orgA}`, {
    cookies: {
      ...sessions.b,
      [sessionCookie]: randomBytes(32).toString('base64url'),
    },
    headers: {
      'X-User-Id': principals.a,
      'X-Organization-Id': orgA,
      Authorization: 'Bearer forged',
    },
  });
  assert.equal(forged.status, 401);
  assert(!forged.text.includes(orgA));
  const parallel = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      request(origin, `/r23/organizations/${index % 2 ? orgB : orgA}`, {
        cookies: sessions[index % 2 ? 'b' : 'a'],
      }),
    ),
  );
  for (let i = 0; i < parallel.length; i++) {
    assert.equal(parallel[i].status, 200);
    noStore(parallel[i]);
    assert(!parallel[i].text.includes(i % 2 ? orgA : orgB));
  }
  proxy.outage(true);
  const unavailable = await request(origin, `/r23/organizations/${orgB}`, {
    cookies: sessions.b,
  });
  assert.equal(unavailable.status, 503);
  noStore(unavailable);
  assert(!unavailable.text.includes(orgB));
  proxy.outage(false);
  assert.equal(
    (
      await request(origin, `/r23/organizations/${orgB}`, {
        cookies: sessions.b,
      })
    ).status,
    200,
  );
  const refresh = await Promise.all([
    mutate('/r23/auth/refresh', ab, undefined),
    mutate('/r23/auth/refresh', ab, {}),
  ]);
  for (const response of refresh) {
    assert.equal(response.status, 204);
    noStore(response);
    assert.equal(response.text, '');
  }
  assert.equal(
    (await request(origin, `/r23/organizations/${orgB}`, { cookies: ab }))
      .status,
    200,
  );
  await stop();
  await start();
  assert.equal(
    (await request(origin, `/r23/organizations/${orgB}`, { cookies: ab }))
      .status,
    200,
    'durable credentials and explicit selection survive Next restart',
  );
  await admin.query(
    "UPDATE hirearchy.organization_memberships SET status='revoked',revoked_at=now(),version=version+1 WHERE organization_id=$1 AND principal_id=$2",
    [orgA, principals.a],
  );
  const revoked = await request(origin, `/r23/organizations/${orgA}`, {
    cookies: sessions.a,
  });
  assert.equal(revoked.status, 403);
  noStore(revoked);
  assert(!revoked.text.includes(orgA));
  const refreshBarrier = proxy.pause('/token?grant_type=refresh_token');
  const inflightRefresh = mutate('/r23/auth/refresh', ab);
  await refreshBarrier.reached;
  const inflightLogout = mutate('/r23/auth/logout', ab);
  refreshBarrier.release();
  const logoutRace = await Promise.all([inflightRefresh, inflightLogout]);
  assert.equal(logoutRace[0].status, 204);
  assert([204, 303].includes(logoutRace[1].status));
  noStore(logoutRace[1]);
  assert.equal(
    (await request(origin, `/r23/organizations/${orgB}`, { cookies: ab }))
      .status,
    401,
  );
  assert.equal((await mutate('/r23/auth/refresh', ab)).status, 401);
  const invalid = await storedCredentials(
    admin,
    sessions.a,
    env.R23_SESSION_KEY,
  );
  const parts = invalid.pair.accessToken.split('.');
  parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
  await invalid.replace({ ...invalid.pair, accessToken: parts.join('.') });
  assert.equal(
    (
      await request(origin, `/r23/organizations/${orgA}`, {
        cookies: sessions.a,
      })
    ).status,
    401,
    'invalid Auth signature denied by real Next route',
  );
  const mismatched = await storedCredentials(
    admin,
    sessions.a,
    env.R23_SESSION_KEY,
  );
  const otherIdentity = await storedCredentials(
    admin,
    sessions.b,
    env.R23_SESSION_KEY,
  );
  try {
    await mismatched.replace({
      ...mismatched.pair,
      accessToken: otherIdentity.pair.accessToken,
    });
    assert.equal(
      (
        await request(origin, `/r23/organizations/${orgA}`, {
          cookies: sessions.a,
        })
      ).status,
      401,
      'a valid Auth token for another subject cannot use this bound session',
    );
  } finally {
    await mismatched.replace(mismatched.pair);
  }
  const external = await storedCredentials(
    admin,
    sessions.signup,
    env.R23_SESSION_KEY,
  );
  const signedOut = await fetch(`${authUrl}/logout?scope=local`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${external.pair.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(signedOut.status, 204);
  assert.equal(
    (await request(origin, '/r23/organizations', { cookies: sessions.signup }))
      .status,
    401,
    'externally revoked Auth session denied',
  );
  const expiredHash = createHash('sha256')
    .update(sessions.revoked[sessionCookie])
    .digest('hex');
  await admin.query(
    "UPDATE r23.server_sessions SET expires_at=now()-interval '1 second' WHERE handle_hash=$1",
    [expiredHash],
  );
  assert.equal(
    (await request(origin, '/r23/organizations', { cookies: sessions.revoked }))
      .status,
    401,
    'expired application session denied',
  );
  const context = await pool.query(
    "SELECT nullif(current_setting('r23.auth_subject_id',true),'') AS subject, nullif(current_setting('r23.organization_id',true),'') AS org, current_user, session_user",
  );
  assert.deepEqual(context.rows[0], {
    subject: null,
    org: null,
    current_user: 'r23_gateway',
    session_user: 'r23_gateway',
  });
  await assert.rejects(
    () => pool.query('SELECT * FROM hirearchy.organization_memberships'),
    { code: '42501' },
  );
  await assert.rejects(() => pool.query('SELECT * FROM auth.sessions'), {
    code: '42501',
  });
  await admin.query(
    "UPDATE hirearchy.organization_memberships SET status='active', revoked_at=null, version=version+1 WHERE organization_id=$1 AND principal_id=$2",
    [orgA, principals.a],
  );
  await runBrowserCheck({
    origin,
    user: users.a,
    orgA,
    orgB,
    evidence,
    admin,
    principalId: principals.a,
    stop,
    start,
    proxy,
  });
  console.log(
    'PASS actual Next requests: A/B/AB isolation, explicit scope, CSRF, revocation, durable refresh/restart/logout, no-store, restricted role',
  );
}
