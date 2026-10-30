import assert from 'node:assert/strict';
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { createServer } from 'node:http';
import { assertVerifiedIdentity, createAuthVerifier } from './auth.mjs';

const ORIGIN = 'https://hirearchy.example.test';
const SESSION_COOKIE = '__Host-hirearchy-session';
const CSRF_COOKIE = '__Host-hirearchy-csrf';
const MAX_BODY_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function denied() {
  return new Error('Auth fixture request denied');
}

function authEndpoint(authUrl, path) {
  const endpoint = new URL(authUrl);
  const requestPath = new URL(path, 'http://fixture.invalid');
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}${requestPath.pathname}`;
  endpoint.search = requestPath.search;
  endpoint.hash = '';
  return endpoint;
}

async function authJson(authUrl, path, body, token) {
  let response;
  try {
    response = await fetch(authEndpoint(authUrl, path), {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw denied();
  }
  if (!response.ok) throw denied();
  try {
    return await response.json();
  } catch {
    throw denied();
  }
}

async function passwordGrant(authUrl, user) {
  const pair = await authJson(authUrl, '/token?grant_type=password', user);
  if (
    typeof pair.access_token !== 'string' ||
    typeof pair.refresh_token !== 'string'
  ) {
    throw denied();
  }
  return pair;
}

async function refreshGrant(authUrl, refreshToken) {
  return authJson(authUrl, '/token?grant_type=refresh_token', {
    refresh_token: refreshToken,
  });
}

async function logoutGrant(authUrl, accessToken) {
  let response;
  try {
    response = await fetch(authEndpoint(authUrl, '/logout?scope=local'), {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw denied();
  }
  if (!response.ok) throw denied();
}

async function readJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json'))
    throw denied();
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw denied();
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw denied();
    return body;
  } catch {
    throw denied();
  }
}

function cookieValue(header, name) {
  const entry = (header ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return entry?.slice(name.length + 1) ?? null;
}

function equalSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function noStore(response) {
  response.setHeader('Cache-Control', 'private, no-store');
}

function sendJson(response, status, value) {
  noStore(response);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}

function sessionCookie(value, clear = false) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax${clear ? '; Max-Age=0' : ''}`;
}

function csrfCookie(value, clear = false) {
  return `${CSRF_COOKIE}=${value}; Path=/; Secure; SameSite=Lax${clear ? '; Max-Age=0' : ''}`;
}

function responseCookies(response) {
  if (typeof response.headers.getSetCookie === 'function')
    return response.headers.getSetCookie();
  const value = response.headers.get('set-cookie');
  return value ? value.split(/, (?=[^;,]+=)/) : [];
}

function cookieFrom(lines, name) {
  for (const line of lines) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(line);
    if (match) return { value: match[1], line };
  }
  return null;
}

function assertNoStore(response) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
}

async function responseText(response, tokens = []) {
  const text = await response.text();
  for (const token of tokens) {
    if (token)
      assert.equal(
        text.includes(token),
        false,
        'Auth token absent from response',
      );
  }
  return text;
}

function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  } catch {
    throw denied();
  }
}

function signedToken(claims, jwtSecret) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  const signature = createHmac('sha256', jwtSecret)
    .update(input)
    .digest('base64url');
  return `${input}.${signature}`;
}

function changedSignature(token) {
  const parts = token.split('.');
  const first = parts[2][0] === 'A' ? 'B' : 'A';
  parts[2] = `${first}${parts[2].slice(1)}`;
  return parts.join('.');
}

async function expectDenied(operation) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.message, 'Authentication denied');
    assert.equal(error.code, 'AUTH_DENIED');
    return true;
  });
}

async function gatewayRequest(
  base,
  path,
  {
    handle,
    csrf,
    body,
    origin = ORIGIN,
    csrfHeader = csrf,
    redirect = 'manual',
  } = {},
) {
  const headers = { Origin: origin };
  if (handle)
    headers.Cookie = `${SESSION_COOKIE}=${handle}${csrf ? `; ${CSRF_COOKIE}=${csrf}` : ''}`;
  if (csrfHeader) headers['X-CSRF-Token'] = csrfHeader;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect,
    signal: AbortSignal.timeout(5000),
  });
}

function gatewayLogin(base, user, redirect = '/fixture') {
  return gatewayRequest(
    base,
    `/login?redirect=${encodeURIComponent(redirect)}`,
    { body: { email: user.email, password: user.password } },
  );
}

function sessionFromResponse(response) {
  const cookies = responseCookies(response);
  const handle = cookieFrom(cookies, SESSION_COOKIE);
  const csrf = cookieFrom(cookies, CSRF_COOKIE);
  assert(handle && csrf, 'gateway returns opaque session and CSRF cookies');
  assert.match(handle.value, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(
    handle.value.includes('.'),
    false,
    'session cookie is not a JWT',
  );
  for (const flag of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax'])
    assert(handle.line.includes(flag));
  for (const line of [handle.line, csrf.line])
    assert.equal(/(?:^|;\s*)Domain=/i.test(line), false, 'host-only cookie');
  for (const flag of ['Path=/', 'Secure', 'SameSite=Lax'])
    assert(csrf.line.includes(flag));
  assert.equal(csrf.line.includes('HttpOnly'), false);
  return { handle: handle.value, csrf: csrf.value };
}

export function createFixtureGateway({
  authUrl,
  issuer,
  audience,
  origin = ORIGIN,
  onAdmission = () => {},
}) {
  // shortcut: single-process memory cannot coordinate workers or survive restarts; use durable fenced storage before production.
  // This fixture stays separate from production routes and configuration.
  const verifier = createAuthVerifier({ authUrl, issuer, audience });
  const sessions = new Map();
  const stats = { refreshRequests: 0, refreshCommits: 0 };
  let nextCommitBarrier = null;

  function currentSession(request) {
    const handle = cookieValue(request.headers.cookie, SESSION_COOKIE);
    return handle ? { handle, session: sessions.get(handle) } : {};
  }

  function csrfValid(request, session) {
    return (
      request.headers.origin === origin &&
      equalSecret(
        cookieValue(request.headers.cookie, CSRF_COOKIE),
        session.csrf,
      ) &&
      equalSecret(request.headers['x-csrf-token'], session.csrf)
    );
  }

  async function refreshSession(handle, session) {
    if (session.closed) return false;
    if (session.refreshPromise) return session.refreshPromise;
    const oldRefreshToken = session.refreshToken;
    const operation = (async () => {
      stats.refreshRequests += 1;
      const pair = await refreshGrant(authUrl, oldRefreshToken);
      if (
        typeof pair.access_token !== 'string' ||
        typeof pair.refresh_token !== 'string' ||
        pair.refresh_token === oldRefreshToken
      ) {
        throw denied();
      }
      const identity = assertVerifiedIdentity(
        await verifier(pair.access_token),
      );
      if (
        identity.subjectId !== session.identity.subjectId ||
        identity.sessionId !== session.identity.sessionId
      ) {
        throw denied();
      }
      const barrier = nextCommitBarrier;
      if (barrier) {
        nextCommitBarrier = null;
        barrier.reached();
        await barrier.wait;
      }
      if (
        session.closed ||
        sessions.get(handle) !== session ||
        session.refreshToken !== oldRefreshToken
      ) {
        return false;
      }
      session.accessToken = pair.access_token;
      session.refreshToken = pair.refresh_token;
      session.refreshRevision += 1;
      stats.refreshCommits += 1;
      return true;
    })();
    session.refreshPromise = operation;
    try {
      return await operation;
    } finally {
      if (session.refreshPromise === operation) session.refreshPromise = null;
    }
  }

  async function route(request, response) {
    noStore(response);
    const url = new URL(request.url, 'http://fixture.invalid');
    if (url.pathname === '/login' && request.method === 'POST') {
      if (request.headers.origin !== origin) {
        sendJson(response, 403, { error: 'request_denied' });
        return;
      }
      const body = await readJson(request);
      const redirects = url.searchParams.getAll('redirect');
      if (
        Object.keys(body).sort().join(',') !== 'email,password' ||
        typeof body.email !== 'string' ||
        typeof body.password !== 'string' ||
        [...url.searchParams.keys()].length !== 1 ||
        redirects.length !== 1 ||
        redirects[0] !== '/fixture'
      ) {
        sendJson(response, 400, { error: 'request_denied' });
        return;
      }
      // Login has no session CSRF token yet; exact Origin is its CSRF boundary.
      const pair = await passwordGrant(authUrl, body);
      const identity = assertVerifiedIdentity(
        await verifier(pair.access_token),
      );
      const handle = randomBytes(32).toString('base64url');
      const csrf = randomBytes(32).toString('base64url');
      sessions.set(handle, {
        accessToken: pair.access_token,
        refreshToken: pair.refresh_token,
        identity: Object.freeze({
          subjectId: identity.subjectId,
          sessionId: identity.sessionId,
        }),
        csrf,
        closed: false,
        refreshPromise: null,
        refreshRevision: 0,
      });
      response.statusCode = 303;
      response.setHeader('Location', '/fixture');
      response.setHeader('Set-Cookie', [
        sessionCookie(handle),
        csrfCookie(csrf),
      ]);
      response.end();
      return;
    }

    if (!['/admit', '/refresh', '/logout'].includes(url.pathname)) {
      sendJson(response, 404, { error: 'request_denied' });
      return;
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'request_denied' });
      return;
    }
    const { handle, session } = currentSession(request);
    if (!session || session.closed) {
      sendJson(response, 401, { error: 'authentication_required' });
      return;
    }
    if (!csrfValid(request, session)) {
      sendJson(response, 403, { error: 'request_denied' });
      return;
    }

    if (url.pathname === '/admit') {
      const identity = assertVerifiedIdentity(
        await verifier(session.accessToken),
      );
      if (
        session.closed ||
        sessions.get(handle) !== session ||
        identity.subjectId !== session.identity.subjectId ||
        identity.sessionId !== session.identity.sessionId
      ) {
        sendJson(response, 401, { error: 'authentication_required' });
        return;
      }
      onAdmission(handle, identity);
      sendJson(response, 200, { authenticated: true });
      return;
    }
    if (url.pathname === '/refresh') {
      if (!(await refreshSession(handle, session))) {
        sendJson(response, 401, { error: 'authentication_required' });
        return;
      }
      noStore(response);
      response.statusCode = 204;
      response.end();
      return;
    }

    const accessToken = session.accessToken;
    session.closed = true;
    session.accessToken = null;
    session.refreshToken = null;
    sessions.delete(handle);
    response.setHeader('Set-Cookie', [
      sessionCookie('', true),
      csrfCookie('', true),
    ]);
    try {
      await logoutGrant(authUrl, accessToken);
      response.statusCode = 204;
      response.end();
    } catch {
      sendJson(response, 502, { error: 'request_denied' });
    }
  }

  const server = createServer((request, response) => {
    void route(request, response).catch(() => {
      if (!response.headersSent)
        sendJson(response, 500, { error: 'request_denied' });
      else response.destroy();
    });
  });

  return {
    async listen() {
      if (!server.listening)
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
      const address = server.address();
      return `http://127.0.0.1:${address.port}`;
    },
    async close() {
      if (nextCommitBarrier) nextCommitBarrier.release();
      if (server.listening)
        await new Promise((resolve) => server.close(resolve));
    },
    inspect(handle) {
      const session = sessions.get(handle);
      return session
        ? Object.freeze({
            closed: session.closed,
            hasAccessToken: typeof session.accessToken === 'string',
            hasRefreshToken: typeof session.refreshToken === 'string',
            refreshRevision: session.refreshRevision,
          })
        : null;
    },
    stats() {
      return Object.freeze({ ...stats });
    },
    pauseNextRefreshCommit() {
      if (nextCommitBarrier) throw new Error('Refresh barrier already pending');
      let signalReached;
      let release;
      const reached = new Promise((resolve) => {
        signalReached = resolve;
      });
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      nextCommitBarrier = {
        reached: signalReached,
        wait,
        release,
      };
      return { reached, release };
    },
  };
}

export async function runAuthChecks({
  authUrl,
  issuer,
  audience,
  jwtSecret,
  users,
}) {
  for (const name of ['a', 'b', 'ab', 'revoked', 'signup']) {
    const user = users?.[name];
    assert(
      user &&
        typeof user.email === 'string' &&
        typeof user.password === 'string',
      `missing disposable ${name} credentials`,
    );
  }
  assert.equal(typeof jwtSecret, 'string');
  const verify = createAuthVerifier({ authUrl, issuer, audience });
  const tokens = {};
  const identities = {};
  for (const name of ['a', 'b', 'ab'])
    tokens[name] = await passwordGrant(authUrl, users[name]);
  await Promise.all(
    ['a', 'b', 'ab'].map(async (name) => {
      identities[name] = await verify(tokens[name].access_token);
      assert.equal(assertVerifiedIdentity(identities[name]), identities[name]);
      assert.deepEqual(Object.keys(identities[name]), [
        'subjectId',
        'sessionId',
        'assurance',
        'email',
        'emailVerified',
      ]);
      assert.equal(Object.isFrozen(identities[name]), true);
      assert.equal(
        identities[name].subjectId,
        jwtClaims(tokens[name].access_token).sub,
      );
      assert.match(identities[name].subjectId, UUID);
      assert.match(identities[name].sessionId, UUID);
      assert.equal(identities[name].email, users[name].email);
      assert.equal(identities[name].emailVerified, true);
      assert.equal('accessToken' in identities[name], false);
      assert.equal('refreshToken' in identities[name], false);
    }),
  );
  assert.notEqual(identities.a.subjectId, identities.b.subjectId);
  assert.notEqual(identities.a.subjectId, identities.ab.subjectId);
  assert.notEqual(identities.b.subjectId, identities.ab.subjectId);
  assert.notEqual(identities.a, identities.b);
  assert.notEqual(await verify(tokens.a.access_token), identities.a);
  assert.throws(() => assertVerifiedIdentity({ ...identities.a }), {
    code: 'AUTH_DENIED',
    message: 'Authentication denied',
  });
  assert.throws(
    () => assertVerifiedIdentity({ subjectId: identities.a.subjectId }),
    {
      code: 'AUTH_DENIED',
      message: 'Authentication denied',
    },
  );

  const validClaims = jwtClaims(tokens.a.access_token);
  const invalidTokens = [
    signedToken(
      { ...validClaims, exp: Math.floor(Date.now() / 1000) - 60 },
      jwtSecret,
    ),
    signedToken({ ...validClaims, iss: `${issuer}/wrong` }, jwtSecret),
    signedToken({ ...validClaims, aud: 'wrong-audience' }, jwtSecret),
    signedToken(
      Object.fromEntries(
        Object.entries(validClaims).filter(([name]) => name !== 'session_id'),
      ),
      jwtSecret,
    ),
    signedToken({ ...validClaims, session_id: randomUUID() }, jwtSecret),
  ];
  for (const token of invalidTokens) await expectDenied(verify(token));
  // This uses the fixture signing secret only to measure issuer trust boundaries.
  let subjectSessionDiagnostic = 'server-denied';
  let mixedIdentity;
  try {
    mixedIdentity = await verify(
      signedToken(
        {
          ...validClaims,
          session_id: jwtClaims(tokens.b.access_token).session_id,
        },
        jwtSecret,
      ),
    );
  } catch (error) {
    if (error.code !== 'AUTH_DENIED') throw error;
  }
  if (mixedIdentity) {
    assertVerifiedIdentity(mixedIdentity);
    assert.equal(mixedIdentity.subjectId, identities.a.subjectId);
    assert.equal(mixedIdentity.sessionId, identities.b.sessionId);
    subjectSessionDiagnostic = 'issuer-trusted-pairing';
  }
  await expectDenied(verify(changedSignature(tokens.a.access_token)));
  await expectDenied(
    createAuthVerifier({
      authUrl: 'http://127.0.0.1:1',
      issuer,
      audience,
    })(tokens.a.access_token),
  );

  const revoked = await passwordGrant(authUrl, users.revoked);
  await logoutGrant(authUrl, revoked.access_token);
  await expectDenied(verify(revoked.access_token));

  const observed = [];
  const gateway = createFixtureGateway({
    authUrl,
    issuer,
    audience,
    onAdmission: (handle, identity) => observed.push({ handle, identity }),
  });
  let lateRefresh;
  let raceBarrier;
  try {
    const base = await gateway.listen();
    for (const redirect of [
      'https://attacker.invalid',
      '//attacker.invalid',
      '/fixture/../elsewhere',
    ]) {
      const response = await gatewayLogin(base, users.a, redirect);
      assert.equal(response.status, 400);
      assertNoStore(response);
      assert.equal((await responseCookies(response)).length, 0);
      assert.equal(
        await responseText(response, [
          tokens.a.access_token,
          tokens.a.refresh_token,
        ]),
        JSON.stringify({ error: 'request_denied' }),
      );
    }

    const sessions = {};
    for (const name of ['a', 'b', 'ab']) {
      const response = await gatewayLogin(base, users[name]);
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/fixture');
      assertNoStore(response);
      assert.equal(await responseText(response), '');
      sessions[name] = sessionFromResponse(response);
    }
    const admitted = await Promise.all(
      ['a', 'b', 'ab'].map((name) =>
        gatewayRequest(base, '/admit', sessions[name]),
      ),
    );
    for (const response of admitted) {
      assert.equal(response.status, 200);
      assertNoStore(response);
      assert.deepEqual(JSON.parse(await responseText(response)), {
        authenticated: true,
      });
    }
    for (const name of ['a', 'b', 'ab']) {
      const observedIdentity = observed.find(
        (entry) => entry.handle === sessions[name].handle,
      )?.identity;
      assert(observedIdentity);
      assert.equal(observedIdentity.subjectId, identities[name].subjectId);
      assert.notEqual(observedIdentity, identities[name]);
    }
    const crossedCookies = await gatewayRequest(base, '/admit', {
      handle: sessions.a.handle,
      csrf: sessions.b.csrf,
    });
    assert.equal(crossedCookies.status, 403);
    assertNoStore(crossedCookies);
    assert.equal(
      await responseText(crossedCookies),
      JSON.stringify({ error: 'request_denied' }),
    );
    const repeatedA = await gatewayRequest(base, '/admit', sessions.a);
    assert.equal(repeatedA.status, 200);
    assertNoStore(repeatedA);
    assert.deepEqual(JSON.parse(await responseText(repeatedA)), {
      authenticated: true,
    });
    const aAdmissions = observed.filter(
      (entry) => entry.handle === sessions.a.handle,
    );
    assert.equal(aAdmissions.length, 2);
    assert.notEqual(aAdmissions[0].identity, aAdmissions[1].identity);

    const signupIdentity = await verify(
      (await passwordGrant(authUrl, users.signup)).access_token,
    );
    const signupResponse = await gatewayLogin(base, users.signup);
    assert.equal(signupResponse.status, 303);
    assertNoStore(signupResponse);
    assert.equal(await responseText(signupResponse), '');
    const signupSession = sessionFromResponse(signupResponse);
    const beforeRefresh = gateway.inspect(signupSession.handle);
    const invalidCsrf = [
      { handle: signupSession.handle },
      {
        handle: signupSession.handle,
        csrf: signupSession.csrf,
        csrfHeader: 'wrong-csrf-value',
      },
      {
        handle: signupSession.handle,
        csrf: signupSession.csrf,
        origin: 'https://attacker.invalid',
      },
    ];
    for (const path of ['/admit', '/refresh', '/logout']) {
      for (const options of invalidCsrf) {
        const response = await gatewayRequest(base, path, options);
        assert.equal(response.status, 403);
        assertNoStore(response);
        assert.equal(
          await responseText(response),
          JSON.stringify({ error: 'request_denied' }),
        );
      }
    }
    assert.deepEqual(gateway.inspect(signupSession.handle), beforeRefresh);
    assert.equal(gateway.stats().refreshRequests, 0);

    const [refreshA, refreshB] = await Promise.all([
      gatewayRequest(base, '/refresh', signupSession),
      gatewayRequest(base, '/refresh', signupSession),
    ]);
    for (const response of [refreshA, refreshB]) {
      assert.equal(response.status, 204);
      assertNoStore(response);
      assert.equal(await responseText(response), '');
      assert.equal(responseCookies(response).length, 0);
    }
    assert.equal(gateway.stats().refreshRequests, 1);
    assert.equal(gateway.stats().refreshCommits, 1);
    assert.equal(gateway.inspect(signupSession.handle).refreshRevision, 1);
    const signupAdmission = await gatewayRequest(base, '/admit', signupSession);
    assert.equal(signupAdmission.status, 200);
    assertNoStore(signupAdmission);
    assert.deepEqual(JSON.parse(await responseText(signupAdmission)), {
      authenticated: true,
    });
    const observedSignup = observed.find(
      (entry) => entry.handle === signupSession.handle,
    )?.identity;
    assert.equal(observedSignup?.subjectId, signupIdentity.subjectId);

    const raceLogin = await gatewayLogin(base, users.signup);
    assert.equal(raceLogin.status, 303);
    assertNoStore(raceLogin);
    assert.equal(await responseText(raceLogin), '');
    const raceSession = sessionFromResponse(raceLogin);
    raceBarrier = gateway.pauseNextRefreshCommit();
    lateRefresh = gatewayRequest(base, '/refresh', raceSession);
    await Promise.race([
      raceBarrier.reached,
      lateRefresh.then(() => {
        throw new Error('refresh did not reach the commit barrier');
      }),
    ]);
    const logout = await gatewayRequest(base, '/logout', raceSession);
    assert.equal(logout.status, 204);
    assertNoStore(logout);
    assert.equal(await responseText(logout), '');
    const clearedCookies = responseCookies(logout);
    assert.equal(clearedCookies.length, 2);
    const clearedSession = cookieFrom(clearedCookies, SESSION_COOKIE);
    const clearedCsrf = cookieFrom(clearedCookies, CSRF_COOKIE);
    assert(clearedSession && clearedCsrf);
    for (const line of [clearedSession.line, clearedCsrf.line]) {
      assert(line.includes('Path=/'));
      assert(line.includes('Secure'));
      assert(line.includes('SameSite=Lax'));
      assert(line.includes('Max-Age=0'));
      assert.equal(/(?:^|;\s*)Domain=/i.test(line), false);
    }
    assert(clearedSession.line.includes('HttpOnly'));
    assert.equal(clearedCsrf.line.includes('HttpOnly'), false);
    assert.equal(gateway.inspect(raceSession.handle), null);
    raceBarrier.release();
    const lateResponse = await lateRefresh;
    assert.equal(lateResponse.status, 401);
    assertNoStore(lateResponse);
    assert.equal(
      await responseText(lateResponse),
      JSON.stringify({ error: 'authentication_required' }),
    );
    const afterLogout = await gatewayRequest(base, '/admit', raceSession);
    assert.equal(afterLogout.status, 401);
    assertNoStore(afterLogout);
    assert.equal(
      await responseText(afterLogout),
      JSON.stringify({ error: 'authentication_required' }),
    );
    assert.equal(gateway.inspect(raceSession.handle), null);
    assert.equal(gateway.stats().refreshRequests, 2);
    assert.equal(gateway.stats().refreshCommits, 1);
  } finally {
    raceBarrier?.release();
    if (lateRefresh) await lateRefresh.catch(() => undefined);
    await gateway.close();
  }
  return { subjectSessionDiagnostic };
}
