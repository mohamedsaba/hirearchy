import { generateKeyPairSync, verify } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../apps/web/src/staging/dispatch.mjs', () => ({
  dispatchStagingProof: vi.fn(async () => ({ ok: true })),
}));
import { dispatchStagingProof } from '../../apps/web/src/staging/dispatch.mjs';
import {
  stagingCallbackGet,
  stagingLoginPost,
  stagingOrganizationPost,
  stagingOrganizationsGet,
} from '../../apps/web/src/staging/browser';
import { stagingPost } from '../../apps/web/src/staging/server';
import { proxy } from '../../apps/web/proxy';
import {
  R23_CSRF_COOKIE,
  R23_SESSION_COOKIE,
  r23IsEnabled,
} from '../../apps/web/src/r23-auth/config';
import { r211ReusableProblemApi } from '../../apps/web/src/r23-auth/server';
import { content as problemContent } from '../staging/journey.mjs';

const subject = '10000000-0000-4000-8000-0000000000a1';
const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
const request = (
  token: string,
  body = JSON.stringify({
    op: 'session.open',
    args: { organizationId: 'org' },
  }),
) =>
  new Request('http://localhost/api/staging/v1', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body,
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('authenticated staging boundary', () => {
  it('allows only the staging route and liveness, keeping legacy lanes disabled', () => {
    vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', 'staging-authenticated');
    vi.stubEnv('HIREARCHY_R23_DISPOSABLE', '1');
    vi.stubEnv('NODE_ENV', 'development');
    expect(r23IsEnabled()).toBe(false);
    expect(
      proxy(
        new NextRequest('http://localhost/api/staging/v1', { method: 'POST' }),
      ).headers.get('x-middleware-next'),
    ).toBe('1');
    expect(
      proxy(new NextRequest('http://localhost/api/staging/v1')).status,
    ).toBe(503);
    expect(
      proxy(
        new NextRequest('http://localhost/api/sessions', { method: 'POST' }),
      ).status,
    ).toBe(503);

    // Allowed browser GET routes
    for (const path of [
      '/r23/login',
      '/r23/auth/callback',
      '/r23/organizations',
      '/r23/organizations/org-1',
      '/r23/organizations/org-1/builder',
      '/r23/organizations/org-1/sessions/session-1',
      '/r23/api/organizations/org-1/assessments/draft',
      '/r23/api/organizations/org-1/assessments/versions/v1',
      '/r23/api/organizations/org-1/reviewers',
      '/r23/api/organizations/org-1/sessions',
      '/r23/api/organizations/org-1/sessions/session-1',
      '/r23/api/organizations/org-1/sessions/session-1/assignments',
      '/r23/api/organizations/org-1/sessions/session-1/candidate-token',
      '/r26/candidate/session-1',
      '/r26/api/candidate/session-1',
      '/r27/organizations/org-1/sessions/session-1',
      '/r27/api/organizations/org-1/sessions/session-1/evidence',
      '/r27/api/organizations/org-1/sessions/session-1/evidence/revisions/rev-1',
      '/r27/api/organizations/org-1/sessions/session-1/observations',
      '/r27/api/organizations/org-1/sessions/session-1/observations/obs-1',
      '/r27/api/organizations/org-1/sessions/session-1/review-packet',
      '/_next/static/test.js',
      '/favicon.ico',
    ]) {
      expect(
        proxy(
          new NextRequest(`http://localhost${path}`, { method: 'GET' }),
        ).headers.get('x-middleware-next'),
      ).toBe('1');
    }

    // Candidate page and main candidate API are available only on read methods.
    for (const [path, method] of [
      ['/r26/candidate/session-1', 'HEAD'],
      ['/r26/api/candidate/session-1', 'HEAD'],
    ] as const) {
      expect(
        proxy(
          new NextRequest(`http://localhost${path}`, { method }),
        ).headers.get('x-middleware-next'),
      ).toBe('1');
    }

    // Allowed browser POST routes
    for (const path of [
      '/api/staging/v1',
      '/r23/auth/login',
      '/r23/auth/logout',
      '/r23/auth/refresh',
      '/r23/organization',
      '/r23/api/organizations/org-1/assessments/validate',
      '/r23/api/organizations/org-1/sessions',
      '/r23/api/organizations/org-1/sessions/session-1/candidate-token',
      '/r27/api/organizations/org-1/sessions/session-1/observations',
      '/r27/api/organizations/org-1/sessions/session-1/review-packet/finalize',
      '/r26/api/candidate/session-1',
    ]) {
      expect(
        proxy(
          new NextRequest(`http://localhost${path}`, { method: 'POST' }),
        ).headers.get('x-middleware-next'),
      ).toBe('1');
    }

    // Allowed browser PUT routes
    for (const path of [
      '/r23/api/organizations/org-1/assessments/draft',
      '/r27/api/organizations/org-1/sessions/session-1/review-packet',
    ]) {
      expect(
        proxy(
          new NextRequest(`http://localhost${path}`, { method: 'PUT' }),
        ).headers.get('x-middleware-next'),
      ).toBe('1');
    }

    expect(
      proxy(
        new NextRequest(
          'http://localhost/r27/api/organizations/org-1/sessions/session-1/observations/00000000-0000-4000-8000-000000000001',
          { method: 'PATCH' },
        ),
      ).headers.get('x-middleware-next'),
    ).toBe('1');

    // Blocked legacy, execution, candidate, and review-write routes
    for (const [path, method] of [
      ['/', 'GET'],
      ['/evaluator', 'GET'],
      ['/api/evaluator/assessments/generate', 'POST'],
      ['/api/evaluator/assessments/preview', 'POST'],
      ['/api/evaluator/assessments', 'POST'],
      ['/r26/candidate', 'GET'],
      ['/r26/candidate/session-1', 'POST'],
      ['/r26/api/candidate/example/execution', 'POST'],
      ['/r26/api/candidate/example/ai', 'POST'],
      ['/r26/api/candidate/session-1/execution', 'GET'],
      ['/r26/api/candidate/session-1/ai', 'GET'],
      ['/r26/api/candidate/session-1', 'PUT'],
      ['/r26/api/candidate/session-1', 'DELETE'],
      ['/api/candidate/sessions/example/terminal/exec', 'POST'],
      [
        '/r27/api/organizations/org-1/sessions/session-1/observations',
        'DELETE',
      ],
      [
        '/r27/api/organizations/org-1/sessions/session-1/observations/obs-1',
        'POST',
      ],
      ['/r27/api/organizations/org-1/sessions/session-1/review-packet', 'POST'],
      [
        '/r27/api/organizations/org-1/sessions/session-1/review-packet',
        'DELETE',
      ],
      [
        '/r27/api/organizations/org-1/sessions/session-1/review-packet/finalize',
        'PUT',
      ],
    ] as const) {
      const blocked = proxy(
        new NextRequest(`http://localhost${path}`, { method }),
      );
      expect(blocked.status).toBe(503);
    }
  });

  it('opens only the problem library routes and methods in authenticated staging', () => {
    vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', 'staging-authenticated');
    const pages = '/r23/organizations/org-1/problems';
    const api = '/r23/api/organizations/org-1/problems';
    const problem = `${api}/problem-1`;
    const reuse = `${problem}/reuse`;
    for (const [method, path] of [
      ['GET', pages],
      ['HEAD', pages],
      ['GET', `${pages}/problem-1`],
      ['GET', api],
      ['HEAD', problem],
      ['GET', problem],
      ['POST', api],
      ['PATCH', problem],
      ['DELETE', problem],
      ['POST', reuse],
    ]) {
      const response = proxy(
        new NextRequest(`http://localhost${path}`, { method }),
      );
      expect(
        response.headers.get('x-middleware-next'),
        `${method} ${path}`,
      ).toBe('1');
    }
    for (const [method, path] of [
      ['POST', pages],
      ['DELETE', api],
      ['POST', problem],
      ['PUT', problem],
      ['GET', reuse],
      ['PATCH', reuse],
      ['POST', `${problem}/unexpected`],
      ['GET', `${api}/problem-1/unexpected`],
    ]) {
      const response = proxy(
        new NextRequest(`http://localhost${path}`, { method }),
      );
      expect(response.status, `${method} ${path}`).toBe(503);
    }
  });

  it('verifies the bearer through GoTrue before dispatch and signs its exact arguments', async () => {
    vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', 'staging-authenticated');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const env = {
      STAGING_AUTH_URL: 'http://127.0.0.1:54321',
      STAGING_AUTH_ISSUER: 'https://auth.example.test',
      STAGING_AUTH_AUDIENCE: 'authenticated',
      STAGING_DATABASE_URL:
        'postgres://r23_gateway:secret@127.0.0.1:5432/staging',
      STAGING_PROOF_PRIVATE_KEY: privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64'),
      STAGING_PROOF_ISSUER: 'hirearchy',
      STAGING_PROOF_AUDIENCE: 'database',
      STAGING_PROOF_KEY_ID: 'key-1',
    };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const token = `${encode({ alg: 'HS256' })}.${encode({ sub: subject, session_id: session, aal: 'aal1', iss: env.STAGING_AUTH_ISSUER, aud: env.STAGING_AUTH_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300, amr: [{ method: 'password', timestamp: 1 }] })}.signature`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ id: subject })),
    );
    expect((await stagingPost(request(token))).status).toBe(200);
    const [url, payload, signature] =
      vi.mocked(dispatchStagingProof).mock.calls[0];
    expect(url).toBe(env.STAGING_DATABASE_URL);
    expect(JSON.parse(payload.toString())).toMatchObject({
      v: 2,
      isRecovery: false,
      sub: subject,
      sid: session,
      op: 'session.open',
      args: { organizationId: 'org' },
    });
    expect(verify(null, payload, publicKey, signature)).toBe(true);
    vi.mocked(dispatchStagingProof).mockClear();
    const draft = {
      title: 'Valid assessment',
      brief: 'A sufficiently long assessment brief',
      durationMinutes: 30,
      terminalEnabled: true,
      integratedAi: false,
      expectedBehavior: ['Behaves correctly'],
      acceptanceCriteria: ['The checks are correct'],
      starterFiles: [{ path: 'main.py', content: 'pass' }],
      primaryFilePath: 'main.py',
      rubric: [
        {
          id: 'a',
          label: 'Correct',
          description: 'Correctness evidence',
          weight: 100,
        },
      ],
    };
    vi.mocked(dispatchStagingProof)
      .mockResolvedValueOnce({ content: draft })
      .mockResolvedValueOnce({ validated: true });
    const validate = (args: object) =>
      request(token, JSON.stringify({ op: 'assessment.validate', args }));
    const ids = { organizationId: 'org', assessmentId: 'assessment' };
    expect(
      (await stagingPost(validate({ ...ids, content: draft }))).status,
    ).toBe(400);
    expect(dispatchStagingProof).not.toHaveBeenCalled();
    expect((await stagingPost(validate(ids))).status).toBe(200);
    const validated = JSON.parse(
      vi.mocked(dispatchStagingProof).mock.calls[1][1].toString(),
    );
    expect(validated).toMatchObject({
      op: 'assessment.validate',
      args: {
        ...ids,
        content: draft,
        validatedVersion: {
          scenarioId: 'authored-assessment',
          scenarioVersion: '1.0.0',
          scenarioTitle: draft.title,
          durationSeconds: 1800,
          terminalEnabled: true,
          integratedAi: false,
          validationReceipt: { executionValidationAvailable: false },
          scenarioSnapshot: { workspaceFiles: { 'main.py': 'pass' } },
        },
      },
    });
    expect(validated.args.validatedVersion.contentDigest).toMatch(
      /^[a-f0-9]{64}$/,
    );
    vi.mocked(dispatchStagingProof).mockClear();
    vi.mocked(dispatchStagingProof)
      .mockResolvedValueOnce({
        content: { ...draft, templateId: 'reservation-moves-v3' },
      })
      .mockResolvedValueOnce({ validated: true });
    expect((await stagingPost(validate(ids))).status).toBe(200);
    const reservation = JSON.parse(
      vi.mocked(dispatchStagingProof).mock.calls[1][1].toString(),
    );
    expect(reservation.args.validatedVersion).toMatchObject({
      scenarioId: 'reservation-moves',
      scenarioVersion: 'v3',
      scenarioSnapshot: {
        scenario: {
          templateId: 'reservation-moves-v3',
          recipe: { id: 'reservation-moves.pytest' },
        },
      },
    });
    vi.mocked(dispatchStagingProof).mockClear();
    vi.mocked(dispatchStagingProof).mockResolvedValueOnce({
      content: { ...draft, title: '' },
    });
    expect((await stagingPost(validate(ids))).status).toBe(422);
    expect(dispatchStagingProof).toHaveBeenCalledTimes(1);
    vi.mocked(dispatchStagingProof).mockClear();
    vi.mocked(dispatchStagingProof).mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: '42501' }),
    );
    expect((await stagingPost(request(token))).status).toBe(403);
    vi.mocked(dispatchStagingProof).mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: '28000' }),
    );
    expect((await stagingPost(request(token))).status).toBe(401);
    vi.mocked(dispatchStagingProof).mockRejectedValueOnce(
      Object.assign(new Error('replay'), { code: '23505' }),
    );
    expect((await stagingPost(request(token))).status).toBe(403);
    vi.mocked(dispatchStagingProof).mockRejectedValueOnce(
      new Error('unavailable'),
    );
    expect((await stagingPost(request(token))).status).toBe(503);
    vi.mocked(dispatchStagingProof).mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    expect((await stagingPost(request(token))).status).toBe(401);
    expect(dispatchStagingProof).not.toHaveBeenCalled();
    expect(
      (
        await stagingPost(
          request(token, JSON.stringify({ op: 'execution.run', args: {} })),
        )
      ).status,
    ).toBe(400);
  });

  it('permits normal login but denies recovery or ineligible credentials before product access', async () => {
    vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', 'staging-authenticated');
    const { privateKey } = generateKeyPairSync('ed25519');
    const env = {
      STAGING_AUTH_URL: 'http://127.0.0.1:54321',
      STAGING_AUTH_ISSUER: 'https://auth.example.test',
      STAGING_AUTH_AUDIENCE: 'authenticated',
      STAGING_DATABASE_URL:
        'postgres://r23_gateway:secret@127.0.0.1:5432/staging',
      STAGING_PROOF_PRIVATE_KEY: privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64'),
      STAGING_PROOF_ISSUER: 'hirearchy',
      STAGING_PROOF_AUDIENCE: 'database',
      STAGING_PROOF_KEY_ID: 'key-1',
    };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

    const makeToken = (amr?: unknown) => {
      const exp = Math.floor(Date.now() / 1000) + 300;
      return `${encode({ alg: 'HS256' })}.${encode({ sub: subject, session_id: session, aal: 'aal1', iss: env.STAGING_AUTH_ISSUER, aud: env.STAGING_AUTH_AUDIENCE, exp, ...(amr === undefined ? {} : { amr }) })}.signature`;
    };
    let grantedToken = makeToken([{ method: 'password', timestamp: 1 }]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).includes('/token?grant_type=password')) {
          return Response.json({
            access_token: grantedToken,
            refresh_token: 'synthetic-refresh-token',
            expires_in: 300,
          });
        }
        return Response.json({ id: subject });
      }),
    );
    const loginRequest = () =>
      new Request('http://localhost/r23/auth/login', {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          email: 'evaluator@example.test',
          password: 'synthetic-password',
        }),
      });

    const normalLogin = await stagingLoginPost(loginRequest());
    expect(normalLogin.status).toBe(303);
    expect(normalLogin.headers.get('set-cookie')).toContain(
      '__Host-r23-session=',
    );

    for (const amr of [
      [
        { method: 'password', timestamp: 1 },
        { method: 'recovery', timestamp: 2 },
      ],
      [{ method: 'otp', timestamp: 1 }],
      [
        { method: 'password', timestamp: 1 },
        { method: 'unknown', timestamp: 2 },
      ],
      undefined,
    ]) {
      grantedToken = makeToken(amr);
      const login = await stagingLoginPost(loginRequest());
      expect(login.status).toBe(401);
      expect(login.headers.get('set-cookie')).toBeNull();
      vi.mocked(dispatchStagingProof).mockClear();
      expect((await stagingPost(request(grantedToken))).status).toBe(401);
      expect(dispatchStagingProof).not.toHaveBeenCalled();
    }
  });

  const organizationId = '11111111-1111-4111-8111-111111111111';
  const otherOrganizationId = '22222222-2222-4222-8222-222222222222';
  const problemId = '33333333-3333-4333-8333-333333333333';

  it.each([
    {
      description: 'stale PATCH',
      method: 'PATCH',
      action: 'update',
      body: { content: problemContent, expectedVersion: 1 },
      sqlState: 'R2111',
      status: 409,
    },
    {
      description: 'stale DELETE',
      method: 'DELETE',
      action: 'delete',
      body: { expectedVersion: 1 },
      sqlState: 'R2111',
      status: 409,
    },
    {
      description: 'unselected organization',
      method: 'GET',
      action: 'get',
      targetOrganizationId: otherOrganizationId,
      status: 404,
    },
    {
      description: 'invalid problem identifier',
      method: 'GET',
      action: 'get',
      targetProblemId: 'invalid-id',
      status: 404,
    },
    {
      description: 'missing problem',
      method: 'GET',
      action: 'get',
      sqlState: 'P0002',
      status: 404,
    },
  ] as const)(
    'retains refreshed credentials after a problem error ($description)',
    async (entry) => {
      vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', 'staging-authenticated');
      const { privateKey } = generateKeyPairSync('ed25519');
      const env = {
        STAGING_AUTH_URL: 'http://127.0.0.1:54321',
        STAGING_AUTH_ISSUER: 'https://auth.example.test',
        STAGING_AUTH_AUDIENCE: 'authenticated',
        STAGING_DATABASE_URL:
          'postgres://r23_gateway:secret@127.0.0.1:5432/staging',
        STAGING_PROOF_PRIVATE_KEY: privateKey
          .export({ format: 'der', type: 'pkcs8' })
          .toString('base64'),
        STAGING_PROOF_ISSUER: 'hirearchy',
        STAGING_PROOF_AUDIENCE: 'database',
        STAGING_PROOF_KEY_ID: 'key-1',
      };
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

      const startedAt = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
      const grant = (expiresIn: number) => ({
        access_token: `${encode({ alg: 'HS256' })}.${encode({
          sub: subject,
          session_id: session,
          aal: 'aal1',
          iss: env.STAGING_AUTH_ISSUER,
          aud: env.STAGING_AUTH_AUDIENCE,
          exp: Math.floor(Date.now() / 1000) + expiresIn,
          amr: [{ method: 'password', timestamp: 1 }],
        })}.signature`,
        refresh_token: `test-refresh-${expiresIn}`,
        expires_in: expiresIn,
      });
      const refresh = vi.fn(() => Response.json(grant(300)));
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/token?grant_type=password')) {
          return Response.json(grant(60));
        }
        if (url.includes('/token?grant_type=refresh_token')) {
          return refresh();
        }
        return Response.json({ id: subject });
      });

      try {
        const cookies = new Map<string, string>();
        const storeCookies = (response: Response) => {
          for (const header of response.headers.getSetCookie()) {
            const [pair] = header.split(';', 1);
            const [name, value] = pair.split('=', 2);
            if (value) cookies.set(name, value);
            else cookies.delete(name);
          }
        };
        const cookieHeader = () =>
          Array.from(cookies, ([name, value]) => `${name}=${value}`).join('; ');
        const browserRequest = (path: string, method = 'GET', body?: object) =>
          new Request(`http://localhost${path}`, {
            method,
            headers: {
              cookie: cookieHeader(),
              origin: 'http://localhost',
              'content-type': 'application/json',
              'x-csrf-token': cookies.get(R23_CSRF_COOKIE) ?? '',
            },
            body: body ? JSON.stringify(body) : undefined,
          });

        const login = await stagingLoginPost(
          browserRequest('/r23/auth/login', 'POST', {
            email: 'recruiter@example.test',
            password: 'synthetic-password',
          }),
        );
        expect(login.status).toBe(303);
        storeCookies(login);
        const callback = await stagingCallbackGet(
          browserRequest('/r23/auth/callback'),
        );
        expect(callback.status).toBe(303);
        storeCookies(callback);
        const selected = await stagingOrganizationPost(
          browserRequest('/r23/organization', 'POST', { organizationId }),
        );
        expect(selected.status).toBe(303);
        storeCookies(selected);
        const previousSession = cookies.get(R23_SESSION_COOKIE);
        expect(previousSession).toBeDefined();
        expect(refresh).not.toHaveBeenCalled();

        clock.mockReturnValue(startedAt + 40_000);
        if ('sqlState' in entry) {
          vi.mocked(dispatchStagingProof).mockRejectedValueOnce(
            Object.assign(new Error('Problem operation failed'), {
              code: entry.sqlState,
            }),
          );
        }
        const targetOrganization =
          'targetOrganizationId' in entry
            ? entry.targetOrganizationId
            : organizationId;
        const targetProblem =
          'targetProblemId' in entry ? entry.targetProblemId : problemId;
        const response = await r211ReusableProblemApi(
          browserRequest(
            `/r23/api/organizations/${targetOrganization}/problems/${targetProblem}`,
            entry.method,
            'body' in entry ? entry.body : undefined,
          ),
          targetOrganization,
          entry.action,
          targetProblem,
        );
        expect(refresh).toHaveBeenCalledOnce();
        expect(response.status).toBe(entry.status);
        expect(await response.json()).toMatchObject({
          error: {
            code:
              entry.status === 409
                ? 'PROBLEM_CONCURRENCY_CONFLICT'
                : 'NOT_FOUND',
          },
        });
        expect(response.headers.getSetCookie()).toEqual([
          expect.stringContaining(`${R23_SESSION_COOKIE}=`),
        ]);
        storeCookies(response);
        expect(cookies.get(R23_SESSION_COOKIE)).not.toBe(previousSession);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it('surfaces organization database failures and renders persisted names', async () => {
    vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', 'staging-authenticated');
    const { privateKey } = generateKeyPairSync('ed25519');
    const env = {
      STAGING_AUTH_URL: 'http://127.0.0.1:54321',
      STAGING_AUTH_ISSUER: 'https://auth.example.test',
      STAGING_AUTH_AUDIENCE: 'authenticated',
      STAGING_DATABASE_URL:
        'postgres://r23_gateway:secret@127.0.0.1:5432/staging',
      STAGING_PROOF_PRIVATE_KEY: privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64'),
      STAGING_PROOF_ISSUER: 'hirearchy',
      STAGING_PROOF_AUDIENCE: 'database',
      STAGING_PROOF_KEY_ID: 'key-1',
    };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

    const token = `${encode({ alg: 'HS256' })}.${encode({
      sub: subject,
      session_id: session,
      aal: 'aal1',
      iss: env.STAGING_AUTH_ISSUER,
      aud: env.STAGING_AUTH_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 300,
      amr: [{ method: 'password', timestamp: 1 }],
    })}.signature`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).includes('/token?grant_type=password')) {
          return Response.json({
            access_token: token,
            refresh_token: 'synthetic-refresh-token',
            expires_in: 300,
          });
        }
        return Response.json({ id: subject });
      }),
    );

    const login = await stagingLoginPost(
      new Request('http://localhost/r23/auth/login', {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          email: 'evaluator@example.test',
          password: 'synthetic-password',
        }),
      }),
    );
    expect(login.status).toBe(303);

    const cookies = new Map<string, string>();
    const mergeResponseCookies = (response: Response) => {
      const raw = response.headers.get('set-cookie') ?? '';
      for (const match of raw.matchAll(
        /(?:^|,\s*)(__Host-r23-[^=;, ]+=[^;,]*)/g,
      )) {
        const pair = match[1].trim();
        const separator = pair.indexOf('=');
        const name = pair.slice(0, separator);
        if (pair.slice(separator + 1) === '') cookies.delete(name);
        else cookies.set(name, pair);
      }
    };
    mergeResponseCookies(login);
    const callback = await stagingCallbackGet(
      new Request('http://localhost/r23/auth/callback', {
        headers: { cookie: [...cookies.values()].join('; ') },
      }),
    );
    expect(callback.status).toBe(303);
    mergeResponseCookies(callback);
    const browserCookies = [...cookies.values()].join('; ');
    const organizationsRequest = () =>
      new Request('http://localhost/r23/organizations', {
        headers: { cookie: browserCookies },
      });

    vi.mocked(dispatchStagingProof).mockClear();
    vi.mocked(dispatchStagingProof).mockRejectedValueOnce(
      Object.assign(new Error('database connection failed'), { code: '08006' }),
    );
    const unavailable = await stagingOrganizationsGet(organizationsRequest());
    const unavailableHtml = await unavailable.text();
    expect(unavailable.status).toBe(500);
    expect(unavailableHtml).toContain('The request could not be completed.');
    expect(unavailableHtml).not.toContain('No active organization membership');
    expect(dispatchStagingProof).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(vi.mocked(dispatchStagingProof).mock.calls[0][1].toString())
        .op,
    ).toBe('onboarding.status');

    vi.mocked(dispatchStagingProof).mockClear();
    vi.mocked(dispatchStagingProof).mockResolvedValueOnce({
      status: 'needs_team',
      email: 'evaluator@example.test',
      capabilities: {
        selfServiceOnboardingEnabled: true,
        emailDeliveryEnabled: false,
      },
    });
    const needsTeam = await stagingOrganizationsGet(organizationsRequest());
    expect(needsTeam.status).toBe(200);
    expect(await needsTeam.text()).toContain('Create your first organization');
    expect(dispatchStagingProof).toHaveBeenCalledTimes(1);

    vi.mocked(dispatchStagingProof).mockClear();
    vi.mocked(dispatchStagingProof)
      .mockResolvedValueOnce({
        status: 'has_active_membership',
        email: 'evaluator@example.test',
        capabilities: {
          selfServiceOnboardingEnabled: true,
          emailDeliveryEnabled: false,
        },
      })
      .mockResolvedValueOnce({
        memberships: [
          {
            organizationId: '11111111-1111-4111-8111-111111111111',
            role: 'recruiter',
            version: 1,
            displayName: 'Meridian Works',
          },
        ],
      });
    const withMembership = await stagingOrganizationsGet(
      organizationsRequest(),
    );
    const organizationsHtml = await withMembership.text();
    expect(withMembership.status).toBe(200);
    expect(organizationsHtml).toContain('Select Meridian Works (recruiter)');
    expect(organizationsHtml).not.toContain('Acme Evaluation Org');
    expect(dispatchStagingProof).toHaveBeenCalledTimes(2);
  });
});
