import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildPeerReviewRequestEmail,
  buildPeerReviewResponseEmail,
  deliverHiringNotificationEmail,
  PEER_REVIEW_REQUEST_SUBJECT_PREFIX,
  PEER_REVIEW_RESPONSE_SUBJECT_PREFIX,
  resolveHiringSmtpConfig,
  verdictDisplayLabel,
} from '../../apps/web/src/hiring/mail';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Peer review email templates and SMTP delivery', () => {
  it('renders Common-Thread HTML and plain-text peer review request emails with escaped content and advisory framing', () => {
    const email = buildPeerReviewRequestEmail({
      organizationName: 'Acme <Systems>',
      organizationId: '11111111-1111-1111-1111-111111111111',
      sessionId: 'sess_peer_001',
      opinionId: '22222222-2222-2222-2222-222222222222',
      scenarioTitle: 'Reservation Moves Concurrency Fix',
      candidateName: 'Nadia <Script> Hassan',
      candidateCode: 'CAND-4821',
      targetRole: 'Senior Backend Engineer',
      requesterName: 'Sarah Chen',
      requesterRole: 'Recruiter',
      recipientName: 'Marcus Vance',
      recipientEmail: 'marcus@acme.test',
      requestNote: 'Check locking around concurrent retries & verify tests.',
      requestContext: {
        evaluatorStrengths: ['Clear test coverage', 'Idiomatic Python'],
        evaluatorWeaknesses: ['Edge case on negative move delta'],
        internalNotesExcerpt: 'Strong communication in screening.',
        aiAdvisory: {
          headline: 'Solid implementation with one boundary risk',
          score: 84,
          verdictLabel: 'Should Accept',
          rationale: 'Clean diff across moves.py; verify negative input guard.',
          providerLabel: 'NVIDIA NIM · Kimi K3.1 Pro',
        },
      },
      reviewUrl:
        'http://127.0.0.1:3310/r27/organizations/11111111-1111-1111-1111-111111111111/sessions/sess_peer_001?tab=review&peerReview=22222222-2222-2222-2222-222222222222',
    });

    expect(email.subject).toBe(
      `${PEER_REVIEW_REQUEST_SUBJECT_PREFIX} Nadia <Script> Hassan (Senior Backend Engineer)`,
    );
    expect(email.text).toContain('Sarah Chen (Recruiter)');
    expect(email.text).toContain('CAND-4821');
    expect(email.text).toContain('advisory only, human decides');
    expect(email.text).toContain(
      'tab=review&peerReview=22222222-2222-2222-2222-222222222222',
    );
    expect(email.html).not.toContain('<Script>');
    expect(email.html).toContain('Nadia &lt;Script&gt; Hassan');
    expect(email.html).toContain('Acme &lt;Systems&gt;');
    expect(email.html).toContain('Advisory AI summary');
    expect(email.html).toContain('#211426');
    expect(email.html).toContain('#8ee3b8');
    expect(email.html).toContain('Open Peer Review');
  });

  it('renders peer review completion emails with distinct verdict labels', () => {
    expect(verdictDisplayLabel('approve')).toContain('Approve');
    expect(verdictDisplayLabel('comment')).toContain('Comment');
    expect(verdictDisplayLabel('request_changes')).toContain(
      'Concerns flagged',
    );

    const response = buildPeerReviewResponseEmail({
      organizationName: 'Acme Systems',
      organizationId: '11111111-1111-1111-1111-111111111111',
      sessionId: 'sess_peer_001',
      opinionId: '22222222-2222-2222-2222-222222222222',
      scenarioTitle: 'Reservation Moves',
      candidateName: 'Nadia Hassan',
      targetRole: 'Senior Backend Engineer',
      reviewerName: 'Marcus Vance',
      recipientName: 'Sarah Chen',
      recipientEmail: 'sarah@acme.test',
      verdict: 'approve',
      responseNote: 'Concurrency guard is solid. Recommend advancing to CTO.',
      reviewUrl:
        'http://127.0.0.1:3310/r27/organizations/11111111-1111-1111-1111-111111111111/sessions/sess_peer_001?tab=review&peerReview=22222222-2222-2222-2222-222222222222',
    });

    expect(response.subject).toBe(
      `${PEER_REVIEW_RESPONSE_SUBJECT_PREFIX} Nadia Hassan (Senior Backend Engineer)`,
    );
    expect(response.text).toContain('Approve · Recommend advancing');
    expect(response.text).toContain('Recommend advancing to CTO.');
    expect(response.html).toContain('View Peer Review');
  });

  it('resolves SMTP configuration from custom SMTP or local Mailpit port', () => {
    vi.stubEnv('HIREARCHY_SMTP_HOST', '');
    vi.stubEnv('HIREARCHY_SMTP_PORT', '');
    vi.stubEnv('FOUNDER_UAT_MAILPIT_SMTP_PORT', '');
    vi.stubEnv('MAILPIT_SMTP_PORT', '');
    expect(resolveHiringSmtpConfig()).toBeNull();

    vi.stubEnv('FOUNDER_UAT_MAILPIT_SMTP_PORT', '1036');
    expect(resolveHiringSmtpConfig()).toMatchObject({
      host: '127.0.0.1',
      port: 1036,
      secure: false,
      isLocalMailpit: true,
    });

    vi.stubEnv('HIREARCHY_SMTP_HOST', 'smtp.acme.example');
    vi.stubEnv('HIREARCHY_SMTP_PORT', '465');
    vi.stubEnv('HIREARCHY_SMTP_SECURE', 'true');
    expect(resolveHiringSmtpConfig()).toMatchObject({
      host: 'smtp.acme.example',
      port: 465,
      secure: true,
      isLocalMailpit: false,
    });
  });

  it('delivers multipart MIME email cleanly over SMTP to a loopback Mailpit-compatible server', async () => {
    const transcript: string[] = [];
    let capturedData = '';
    const server = net.createServer((socket) => {
      let inData = false;
      let buf = '';
      socket.write('220 localhost ESMTP HirearchyTest\r\n');
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (inData) {
          const endIdx = buf.indexOf('\r\n.\r\n');
          if (endIdx !== -1) {
            capturedData += buf.slice(0, endIdx);
            buf = buf.slice(endIdx + 5);
            inData = false;
            socket.write('250 2.0.0 Queued\r\n');
          }
          return;
        }
        while (buf.includes('\r\n')) {
          const idx = buf.indexOf('\r\n');
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          transcript.push(line);
          if (line.startsWith('EHLO')) {
            socket.write('250-localhost\r\n250 SIZE 10485760\r\n');
          } else if (
            line.startsWith('MAIL FROM:') ||
            line.startsWith('RCPT TO:')
          ) {
            socket.write('250 OK\r\n');
          } else if (line === 'DATA') {
            inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
            break;
          } else if (line === 'QUIT') {
            socket.write('221 Bye\r\n');
            socket.end();
          }
        }
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      vi.stubEnv('HIREARCHY_SMTP_HOST', '');
      vi.stubEnv('FOUNDER_UAT_MAILPIT_SMTP_PORT', String(port));

      const rendered = buildPeerReviewRequestEmail({
        organizationName: 'Acme Corp',
        organizationId: '11111111-1111-1111-1111-111111111111',
        sessionId: 'sess_smtp_1',
        opinionId: '33333333-3333-3333-3333-333333333333',
        scenarioTitle: 'API Idempotency',
        candidateName: 'Omar Nabil',
        targetRole: 'Backend Engineer',
        requesterName: 'Lina',
        requesterRole: 'Recruiter',
        recipientName: 'Tarek',
        recipientEmail: 'tarek@acme.test',
        requestNote: 'Please verify retry safety.',
        reviewUrl:
          'http://127.0.0.1:3310/r27/organizations/11111111-1111-1111-1111-111111111111/sessions/sess_smtp_1?tab=review&peerReview=33333333-3333-3333-3333-333333333333',
      });

      const delivery = await deliverHiringNotificationEmail(
        'tarek@acme.test',
        rendered,
      );

      expect(delivery).toEqual({
        status: 'sent',
        recipientEmail: 'tarek@acme.test',
        inboxUrl: '/r23/mail?email=tarek%40acme.test',
      });
      expect(transcript).toContain('RCPT TO:<tarek@acme.test>');
      expect(capturedData).toContain('Content-Type: multipart/alternative');
      expect(capturedData).toContain('Please verify retry safety.');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
