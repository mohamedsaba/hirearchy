import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FounderUatMailMessageDenied,
  listFounderUatMessages,
  readFounderUatMessageAction,
  readFounderUatMessageOtp,
} from '../../apps/web/src/runtime/founder-uat-mail';
import type { FounderUatConfiguration } from '../../apps/web/src/runtime/founder-uat';

const config: FounderUatConfiguration = {
  appOrigin: new URL('http://127.0.0.1:3000'),
  authUrl: new URL('http://127.0.0.1:9998'),
  authIssuer: 'http://127.0.0.1:9998/auth/v1',
  authAudience: 'authenticated',
  databaseUrl: 'postgresql://r23_gateway:local-test@127.0.0.1:5432/postgres',
  mailpitApiUrl: new URL('http://127.0.0.1:8025'),
};

afterEach(() => vi.unstubAllGlobals());

describe('Founder UAT local mail capture', () => {
  it('returns only safe metadata for exact-recipient GoTrue messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          messages: [
            {
              ID: 'confirmation_1',
              To: [{ Address: 'Founder@Local.Test' }],
              Subject: 'Hirearchy account confirmation',
              Created: '2026-11-10T10:00:00Z',
              Snippet: '123456',
            },
            {
              ID: 'other_1',
              To: [{ Email: 'other@local.test' }],
              Subject: 'Hirearchy account confirmation',
              Created: '2026-11-10T10:00:00Z',
            },
            {
              ID: 'unrelated_1',
              To: [{ Email: 'founder@local.test' }],
              Subject: 'A different message',
              Created: '2026-11-10T10:00:00Z',
            },
          ],
        }),
      ),
    );

    const messages = await listFounderUatMessages(config, 'Founder@Local.Test');
    expect(messages).toEqual([
      {
        id: 'confirmation_1',
        recipient: 'founder@local.test',
        subject: 'Hirearchy account confirmation',
        receivedAt: '2026-11-10T10:00:00.000Z',
        kind: 'confirmation',
      },
    ]);
    expect(JSON.stringify(messages)).not.toMatch(/123456|Snippet|HTML|token/i);
    const [requestUrl, requestInit] = vi.mocked(fetch).mock.calls[0];
    expect(String(requestUrl)).toContain(
      'http://127.0.0.1:8025/api/v1/search?',
    );
    expect(String(requestUrl)).toContain('to%3A%22founder%40local.test%22');
    expect(requestInit).toMatchObject({ method: 'GET', redirect: 'error' });
  });

  it('extracts one OTP only after exact recipient and message purpose checks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ID: 'recovery_1',
          To: [{ Email: 'founder@local.test' }],
          Subject: 'Hirearchy password recovery',
          Text: 'Use verification code 654321 to reset your password.',
          HTML: '<p>Never return HTML to the browser.</p>',
        }),
      ),
    );

    await expect(
      readFounderUatMessageOtp(config, 'founder@local.test', 'recovery_1'),
    ).resolves.toEqual({ kind: 'recovery', otp: '654321' });
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe(
      'http://127.0.0.1:8025/api/v1/message/recovery_1',
    );
  });

  it('rejects wrong-recipient or ambiguous captures', async () => {
    const response = (to: string, text: string) =>
      Response.json({
        ID: 'recovery_2',
        To: [{ Email: to }],
        Subject: 'Hirearchy password recovery',
        Text: text,
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response('other@local.test', '654321')),
    );
    await expect(
      readFounderUatMessageOtp(config, 'founder@local.test', 'recovery_2'),
    ).rejects.toBeInstanceOf(FounderUatMailMessageDenied);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response('founder@local.test', '654321 123456')),
    );
    await expect(
      readFounderUatMessageOtp(config, 'founder@local.test', 'recovery_2'),
    ).rejects.toBeInstanceOf(FounderUatMailMessageDenied);
  });

  it('lists peer review notifications and extracts safe same-origin review links', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.includes('/api/v1/search?')) {
          return Response.json({
            messages: [
              {
                ID: 'peer_1',
                To: [{ Address: 'lead@local.test' }],
                Subject:
                  '[Hirearchy] Peer review requested: Nadia Hassan (Senior Backend Engineer)',
                Created: '2026-11-21T12:00:00Z',
              },
              {
                ID: 'peer_2',
                To: [{ Address: 'lead@local.test' }],
                Subject:
                  '[Hirearchy] Peer review submitted: Nadia Hassan (Senior Backend Engineer)',
                Created: '2026-11-21T12:10:00Z',
              },
            ],
          });
        }
        return Response.json({
          ID: 'peer_1',
          To: [{ Email: 'lead@local.test' }],
          Subject:
            '[Hirearchy] Peer review requested: Nadia Hassan (Senior Backend Engineer)',
          Text: 'Inspect review:\nhttp://127.0.0.1:3000/r27/organizations/11111111-1111-1111-1111-111111111111/sessions/sess_demo_1?tab=review&peerReview=22222222-2222-2222-2222-222222222222\n',
        });
      }),
    );

    const listed = await listFounderUatMessages(config, 'lead@local.test');
    expect(listed.map((m) => m.kind)).toEqual([
      'peer_review_request',
      'peer_review_response',
    ]);

    await expect(
      readFounderUatMessageAction(config, 'lead@local.test', 'peer_1'),
    ).resolves.toEqual({
      kind: 'peer_review_request',
      reviewPath:
        '/r27/organizations/11111111-1111-1111-1111-111111111111/sessions/sess_demo_1?tab=review&peerReview=22222222-2222-2222-2222-222222222222',
    });
  });

  it('rejects peer review emails pointing to off-origin URLs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ID: 'peer_evil',
          To: [{ Email: 'lead@local.test' }],
          Subject: '[Hirearchy] Peer review requested: Evil',
          Text: 'Click https://evil.example/r27/organizations/11111111-1111-1111-1111-111111111111/sessions/sess_1',
        }),
      ),
    );

    await expect(
      readFounderUatMessageAction(config, 'lead@local.test', 'peer_evil'),
    ).rejects.toBeInstanceOf(FounderUatMailMessageDenied);
  });
});
