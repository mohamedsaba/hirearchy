import { generateKeyPairSync, verify } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../apps/web/src/staging/dispatch.mjs', () => ({
  dispatchStagingProof: vi.fn(async () => ({ ok: true })),
}));
import { dispatchStagingProof } from '../../apps/web/src/staging/dispatch.mjs';
import { stagingPost } from '../../apps/web/src/staging/server';
import { proxy } from '../../apps/web/proxy';
import { r23IsEnabled } from '../../apps/web/src/r23-auth/config';

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

    // Allowed browser POST routes
    for (const path of [
      '/api/staging/v1',
      '/r23/auth/login',
      '/r23/auth/logout',
      '/r23/auth/refresh',
      '/r23/organization',
      '/r23/api/organizations/org-1/assessments/validate',
      '/r23/api/organizations/org-1/sessions',
    ]) {
      expect(
        proxy(
          new NextRequest(`http://localhost${path}`, { method: 'POST' }),
        ).headers.get('x-middleware-next'),
      ).toBe('1');
    }

    // Allowed browser PUT routes
    expect(
      proxy(
        new NextRequest(
          'http://localhost/r23/api/organizations/org-1/assessments/draft',
          {
            method: 'PUT',
          },
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
      ['/r26/api/candidate/example/execution', 'POST'],
      ['/r26/api/candidate/example/ai', 'POST'],
      ['/api/candidate/sessions/example/terminal/exec', 'POST'],
      ['/r27/api/organizations/org-1/sessions/session-1/observations', 'POST'],
      ['/r27/api/organizations/org-1/sessions/session-1/review-packet', 'POST'],
      ['/r27/api/organizations/org-1/sessions/session-1/review-packet', 'PUT'],
    ] as const) {
      const blocked = proxy(
        new NextRequest(`http://localhost${path}`, { method }),
      );
      expect(blocked.status).toBe(503);
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
    const token = `${encode({ alg: 'HS256' })}.${encode({ sub: subject, session_id: session, aal: 'aal1', iss: env.STAGING_AUTH_ISSUER, aud: env.STAGING_AUTH_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300 })}.signature`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ id: subject })),
    );
    expect((await stagingPost(request(token))).status).toBe(200);
    const [url, payload, signature] =
      vi.mocked(dispatchStagingProof).mock.calls[0];
    expect(url).toBe(env.STAGING_DATABASE_URL);
    expect(JSON.parse(payload.toString())).toMatchObject({
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
});
