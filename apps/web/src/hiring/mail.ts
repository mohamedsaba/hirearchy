import net from 'node:net';
import tls from 'node:tls';

import type {
  PeerReviewEmailDelivery,
  PeerReviewRequestContext,
  PeerReviewVerdict,
} from './types';

export const PEER_REVIEW_REQUEST_SUBJECT_PREFIX =
  '[Hirearchy] Peer review requested:';
export const PEER_REVIEW_RESPONSE_SUBJECT_PREFIX =
  '[Hirearchy] Peer review submitted:';

export interface SmtpTransportConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user?: string;
  readonly pass?: string;
  readonly from: string;
  readonly isLocalMailpit: boolean;
}

export interface PeerReviewRequestEmailInput {
  readonly organizationName: string;
  readonly organizationId: string;
  readonly sessionId: string;
  readonly opinionId: string;
  readonly scenarioTitle: string;
  readonly candidateName: string;
  readonly candidateCode?: string | null;
  readonly targetRole: string;
  readonly requesterName: string;
  readonly requesterRole: string;
  readonly recipientName: string;
  readonly recipientEmail: string;
  readonly requestNote: string;
  readonly requestContext?: PeerReviewRequestContext | null;
  readonly reviewUrl: string;
}

export interface PeerReviewResponseEmailInput {
  readonly organizationName: string;
  readonly organizationId: string;
  readonly sessionId: string;
  readonly opinionId: string;
  readonly scenarioTitle: string;
  readonly candidateName: string;
  readonly targetRole: string;
  readonly reviewerName: string;
  readonly recipientName: string;
  readonly recipientEmail: string;
  readonly verdict: PeerReviewVerdict;
  readonly responseNote: string;
  readonly reviewUrl: string;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return char;
    }
  });
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f]+/g, ' ').trim();
}

export function verdictDisplayLabel(verdict: PeerReviewVerdict): string {
  switch (verdict) {
    case 'approve':
      return 'Approve · Recommend advancing';
    case 'request_changes':
      return 'Concerns flagged · Hold / Do not advance';
    case 'comment':
    default:
      return 'Comment · Peer perspective';
  }
}

export function resolveHiringSmtpConfig(): SmtpTransportConfig | null {
  const customHost = process.env.HIREARCHY_SMTP_HOST?.trim();
  const customPort = Number(process.env.HIREARCHY_SMTP_PORT ?? '');
  if (customHost && Number.isInteger(customPort) && customPort > 0) {
    return {
      host: customHost,
      port: customPort,
      secure: process.env.HIREARCHY_SMTP_SECURE === 'true',
      user: process.env.HIREARCHY_SMTP_USER?.trim() || undefined,
      pass: process.env.HIREARCHY_SMTP_PASS || undefined,
      from:
        process.env.HIREARCHY_SMTP_FROM?.trim() ||
        'Hirearchy Software <reviews@hirearchy.local>',
      isLocalMailpit: false,
    };
  }

  const mailpitPort = Number(
    process.env.FOUNDER_UAT_MAILPIT_SMTP_PORT ??
      process.env.MAILPIT_SMTP_PORT ??
      '',
  );
  if (Number.isInteger(mailpitPort) && mailpitPort > 0) {
    return {
      host: '127.0.0.1',
      port: mailpitPort,
      secure: false,
      from: 'Hirearchy Software <reviews@hirearchy.local>',
      isLocalMailpit: true,
    };
  }

  return null;
}

export function buildPeerReviewRequestEmail(
  input: PeerReviewRequestEmailInput,
): RenderedEmail {
  const candidateLabel = input.candidateName || 'Candidate';
  const roleLabel = input.targetRole || 'Software Engineer';
  const subject = sanitizeHeader(
    `${PEER_REVIEW_REQUEST_SUBJECT_PREFIX} ${candidateLabel} (${roleLabel})`,
  );

  const ctx = input.requestContext ?? {};
  const strengths = (ctx.evaluatorStrengths ?? []).filter(Boolean).slice(0, 6);
  const weaknesses = (ctx.evaluatorWeaknesses ?? [])
    .filter(Boolean)
    .slice(0, 6);
  const internalExcerpt = (ctx.internalNotesExcerpt ?? '').trim();
  const ai = ctx.aiAdvisory ?? null;

  const textLines: string[] = [
    `Hi ${input.recipientName || 'there'},`,
    '',
    `${input.requesterName} (${input.requesterRole}) requested your peer review on ${candidateLabel}'s engineering assessment at ${input.organizationName || 'your workspace'}.`,
    '',
    `Candidate: ${candidateLabel}${input.candidateCode ? ` (${input.candidateCode})` : ''}`,
    `Role: ${roleLabel}`,
    `Assessment: ${input.scenarioTitle || input.sessionId}`,
  ];

  if (input.requestNote.trim()) {
    textLines.push('', 'Focus note from requester:', input.requestNote.trim());
  }

  if (strengths.length > 0) {
    textLines.push(
      '',
      'Strengths noted so far:',
      ...strengths.map((s) => `- ${s}`),
    );
  }
  if (weaknesses.length > 0) {
    textLines.push(
      '',
      'Areas to probe / concerns noted so far:',
      ...weaknesses.map((w) => `- ${w}`),
    );
  }
  if (internalExcerpt) {
    textLines.push('', 'Private reviewer notes:', internalExcerpt);
  }
  if (ai) {
    textLines.push(
      '',
      `Advisory AI Review summary (${ai.providerLabel} — advisory only, human decides):`,
      `${ai.verdictLabel} (${ai.score}/100) — ${ai.headline}`,
      ai.rationale,
    );
  }

  textLines.push(
    '',
    'Inspect the full chronological evidence, code diffs, and submit your review:',
    input.reviewUrl,
    '',
    'You can approve, leave comments, or flag concerns directly on the review page without filling out the final decision packet.',
    '',
    '— Hirearchy Software (Evidence informs. People decide.)',
  );

  const noteHtml = input.requestNote.trim()
    ? `<div style="margin:18px 0;padding:14px 16px;background:#ffffff;border:1px solid #ded4cc;border-left:3px solid #211426;border-radius:8px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#635661;margin-bottom:6px;">What ${escapeHtml(input.requesterName)} wants you to inspect</div>
        <p style="margin:0;color:#291d2c;font-size:14px;line-height:1.55;white-space:pre-wrap;">${escapeHtml(input.requestNote.trim())}</p>
      </div>`
    : '';

  const contextBlocks: string[] = [];
  if (strengths.length > 0 || weaknesses.length > 0 || internalExcerpt) {
    const parts: string[] = [];
    if (strengths.length > 0) {
      parts.push(
        `<p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#166534;">Strengths noted</p><ul style="margin:0 0 10px;padding-left:18px;font-size:13px;color:#291d2c;">${strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`,
      );
    }
    if (weaknesses.length > 0) {
      parts.push(
        `<p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#74520a;">Areas to probe</p><ul style="margin:0 0 10px;padding-left:18px;font-size:13px;color:#291d2c;">${weaknesses.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`,
      );
    }
    if (internalExcerpt) {
      parts.push(
        `<p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#635661;">Reviewer notes</p><p style="margin:0;font-size:13px;color:#291d2c;white-space:pre-wrap;">${escapeHtml(internalExcerpt)}</p>`,
      );
    }
    contextBlocks.push(
      `<div style="margin:14px 0;padding:14px 16px;background:#f3ede6;border:1px solid #ded4cc;border-radius:8px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#635661;margin-bottom:8px;">Shared reviewer context</div>
        ${parts.join('')}
      </div>`,
    );
  }

  if (ai) {
    contextBlocks.push(
      `<div style="margin:14px 0;padding:14px 16px;background:#eee7f4;border:1px solid #d5c9e0;border-radius:8px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#4f4059;margin-bottom:6px;">Advisory AI summary · ${escapeHtml(ai.providerLabel)} (advisory only)</div>
        <p style="margin:0 0 6px;font-size:14px;font-weight:700;color:#211426;">${escapeHtml(ai.verdictLabel)} · ${ai.score}/100 — ${escapeHtml(ai.headline)}</p>
        <p style="margin:0;font-size:13px;line-height:1.5;color:#291d2c;">${escapeHtml(ai.rationale)}</p>
      </div>`,
    );
  }

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:24px;background:#f5efe6;font-family:-apple-system,BlinkMacSystemFont,'DM Sans','Segoe UI',sans-serif;color:#291d2c;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #ded4cc;border-radius:12px;overflow:hidden;">
    <div style="padding:18px 24px;background:#211426;color:#f5efe6;">
      <span style="font-size:18px;font-weight:700;letter-spacing:-0.02em;">Hirearchy</span>
      <span style="display:inline-block;margin-left:8px;padding:3px 7px;border-radius:4px;background:#8ee3b8;color:#211426;font-size:11px;font-weight:700;vertical-align:middle;">Software</span>
      <span style="float:right;font-size:12px;color:#d6ccde;line-height:24px;">Peer review request</span>
    </div>
    <div style="padding:24px;">
      <p style="margin:0 0 12px;font-size:15px;line-height:1.5;"><strong>${escapeHtml(input.requesterName)}</strong> (${escapeHtml(input.requesterRole)}) requested your peer review for <strong>${escapeHtml(candidateLabel)}</strong>.</p>
      <table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:13px;background:#faf7f2;border:1px solid #eae1d9;border-radius:8px;">
        <tr><td style="padding:8px 12px;color:#635661;width:120px;">Workspace</td><td style="padding:8px 12px;font-weight:600;">${escapeHtml(input.organizationName || 'Hirearchy Team')}</td></tr>
        <tr><td style="padding:8px 12px;color:#635661;border-top:1px solid #eae1d9;">Candidate</td><td style="padding:8px 12px;font-weight:600;border-top:1px solid #eae1d9;">${escapeHtml(candidateLabel)}${input.candidateCode ? ` <code style="background:#ebe5f2;padding:2px 6px;border-radius:4px;font-size:12px;">${escapeHtml(input.candidateCode)}</code>` : ''}</td></tr>
        <tr><td style="padding:8px 12px;color:#635661;border-top:1px solid #eae1d9;">Role</td><td style="padding:8px 12px;border-top:1px solid #eae1d9;">${escapeHtml(roleLabel)}</td></tr>
        <tr><td style="padding:8px 12px;color:#635661;border-top:1px solid #eae1d9;">Assessment</td><td style="padding:8px 12px;border-top:1px solid #eae1d9;">${escapeHtml(input.scenarioTitle || input.sessionId)}</td></tr>
      </table>
      ${noteHtml}
      ${contextBlocks.join('')}
      <div style="margin:24px 0 14px;">
        <a href="${escapeHtml(input.reviewUrl)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#211426;color:#f5efe6;text-decoration:none;font-size:14px;font-weight:700;">Open Peer Review &rarr;</a>
      </div>
      <p style="margin:0;font-size:12px;line-height:1.5;color:#635661;">You already have direct read access to the candidate&apos;s submitted diffs, timeline, and execution logs. Choose Approve, Comment, or Flag concerns right on the review tab.</p>
    </div>
    <div style="padding:14px 24px;background:#faf7f2;border-top:1px solid #eae1d9;font-size:12px;color:#635661;">
      Hirearchy Software &middot; Evidence informs. People decide.
    </div>
  </div>
</body>
</html>`;

  return { subject, text: textLines.join('\n'), html };
}

export function buildPeerReviewResponseEmail(
  input: PeerReviewResponseEmailInput,
): RenderedEmail {
  const candidateLabel = input.candidateName || 'Candidate';
  const roleLabel = input.targetRole || 'Software Engineer';
  const verdictText = verdictDisplayLabel(input.verdict);
  const subject = sanitizeHeader(
    `${PEER_REVIEW_RESPONSE_SUBJECT_PREFIX} ${candidateLabel} (${roleLabel})`,
  );

  const text = [
    `Hi ${input.recipientName || 'there'},`,
    '',
    `${input.reviewerName} submitted their peer review for ${candidateLabel} (${roleLabel}) at ${input.organizationName || 'your workspace'}.`,
    '',
    `Assessment: ${input.scenarioTitle || input.sessionId}`,
    `Verdict: ${verdictText}`,
    '',
    'Review note:',
    input.responseNote.trim(),
    '',
    'Open the review workspace:',
    input.reviewUrl,
    '',
    '— Hirearchy Software (Evidence informs. People decide.)',
  ].join('\n');

  const badgeColors =
    input.verdict === 'approve'
      ? { bg: '#ecfdf3', fg: '#166534', border: '#bbf7d0' }
      : input.verdict === 'request_changes'
        ? { bg: '#fef2f2', fg: '#b42318', border: '#fecaca' }
        : { bg: '#eee7f4', fg: '#211426', border: '#d5c9e0' };

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:24px;background:#f5efe6;font-family:-apple-system,BlinkMacSystemFont,'DM Sans','Segoe UI',sans-serif;color:#291d2c;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #ded4cc;border-radius:12px;overflow:hidden;">
    <div style="padding:18px 24px;background:#211426;color:#f5efe6;">
      <span style="font-size:18px;font-weight:700;letter-spacing:-0.02em;">Hirearchy</span>
      <span style="display:inline-block;margin-left:8px;padding:3px 7px;border-radius:4px;background:#8ee3b8;color:#211426;font-size:11px;font-weight:700;vertical-align:middle;">Software</span>
      <span style="float:right;font-size:12px;color:#d6ccde;line-height:24px;">Peer review submitted</span>
    </div>
    <div style="padding:24px;">
      <p style="margin:0 0 12px;font-size:15px;line-height:1.5;"><strong>${escapeHtml(input.reviewerName)}</strong> finished reviewing <strong>${escapeHtml(candidateLabel)}</strong> (${escapeHtml(roleLabel)}).</p>
      <div style="margin:12px 0;display:inline-block;padding:6px 12px;border-radius:999px;background:${badgeColors.bg};color:${badgeColors.fg};border:1px solid ${badgeColors.border};font-size:12px;font-weight:700;">${escapeHtml(verdictText)}</div>
      <div style="margin:14px 0;padding:14px 16px;background:#faf7f2;border:1px solid #ded4cc;border-radius:8px;">
        <p style="margin:0;font-size:14px;line-height:1.55;white-space:pre-wrap;">${escapeHtml(input.responseNote.trim())}</p>
      </div>
      <div style="margin:22px 0 10px;">
        <a href="${escapeHtml(input.reviewUrl)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#211426;color:#f5efe6;text-decoration:none;font-size:14px;font-weight:700;">View Peer Review &rarr;</a>
      </div>
    </div>
    <div style="padding:14px 24px;background:#faf7f2;border-top:1px solid #eae1d9;font-size:12px;color:#635661;">
      Hirearchy Software &middot; Evidence informs. People decide.
    </div>
  </div>
</body>
</html>`;

  return { subject, text, html };
}

function buildMimeMessage(params: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}): string {
  const boundary = `hirearchy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const dotStuff = (body: string) =>
    body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');

  return [
    `From: ${sanitizeHeader(params.from)}`,
    `To: ${sanitizeHeader(params.to)}`,
    `Subject: ${sanitizeHeader(params.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    dotStuff(params.text),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    dotStuff(params.html),
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

function extractAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return sanitizeHeader(match ? match[1] : raw);
}

async function sendRawSmtp(
  config: SmtpTransportConfig,
  toEmail: string,
  rendered: RenderedEmail,
): Promise<void> {
  const cleanTo = sanitizeHeader(toEmail);
  const envelopeFrom = extractAddress(config.from);
  const message = buildMimeMessage({
    from: config.from,
    to: cleanTo,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  });

  await new Promise<void>((resolve, reject) => {
    const socket = config.secure
      ? tls.connect({
          host: config.host,
          port: config.port,
          servername: config.host,
          timeout: 5000,
        })
      : net.createConnection({
          host: config.host,
          port: config.port,
          timeout: 5000,
        });

    let buffer = '';
    let settled = false;
    let waitingResolve: ((reply: string) => void) | null = null;
    let waitingReject: ((err: Error) => void) | null = null;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (waitingReject) {
        const r = waitingReject;
        waitingReject = null;
        waitingResolve = null;
        r(err);
      } else {
        reject(err);
      }
    };

    const readReply = (): Promise<string> =>
      new Promise((res, rej) => {
        const tryConsume = () => {
          const lines = buffer.split('\r\n');
          for (let i = 0; i < lines.length - 1; i += 1) {
            if (/^\d{3} /.test(lines[i])) {
              const reply = lines.slice(0, i + 1).join('\r\n');
              buffer = lines.slice(i + 1).join('\r\n');
              res(reply);
              return true;
            }
          }
          return false;
        };
        if (tryConsume()) return;
        waitingResolve = res;
        waitingReject = rej;
      });

    socket.setEncoding('utf8');
    socket.on('timeout', () => fail(new Error('SMTP connection timed out')));
    socket.on('error', (err) => fail(err));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (!waitingResolve) return;
      const lines = buffer.split('\r\n');
      for (let i = 0; i < lines.length - 1; i += 1) {
        if (/^\d{3} /.test(lines[i])) {
          const reply = lines.slice(0, i + 1).join('\r\n');
          buffer = lines.slice(i + 1).join('\r\n');
          const res = waitingResolve;
          waitingResolve = null;
          waitingReject = null;
          res(reply);
          return;
        }
      }
    });

    const sendCmd = async (cmd: string, expectedCodePrefix: string) => {
      socket.write(`${cmd}\r\n`);
      const reply = await readReply();
      if (!reply.startsWith(expectedCodePrefix)) {
        throw new Error(`SMTP error for ${cmd.split(' ')[0]}: ${reply}`);
      }
      return reply;
    };

    void (async () => {
      try {
        const greeting = await readReply();
        if (!greeting.startsWith('220')) {
          throw new Error(`Unexpected SMTP greeting: ${greeting}`);
        }
        await sendCmd('EHLO hirearchy.local', '250');
        if (config.user && config.pass) {
          const authToken = Buffer.from(
            `\0${config.user}\0${config.pass}`,
            'utf8',
          ).toString('base64');
          await sendCmd(`AUTH PLAIN ${authToken}`, '235');
        }
        await sendCmd(`MAIL FROM:<${envelopeFrom}>`, '250');
        await sendCmd(`RCPT TO:<${cleanTo}>`, '250');
        await sendCmd('DATA', '354');
        socket.write(`${message}\r\n.\r\n`);
        const dataReply = await readReply();
        if (!dataReply.startsWith('250')) {
          throw new Error(`SMTP DATA rejected: ${dataReply}`);
        }
        await sendCmd('QUIT', '221').catch(() => undefined);
        if (!settled) {
          settled = true;
          socket.end();
          resolve();
        }
      } catch (err) {
        fail(err instanceof Error ? err : new Error('SMTP delivery failed'));
      }
    })();
  });
}

export async function deliverHiringNotificationEmail(
  recipientEmail: string,
  rendered: RenderedEmail,
): Promise<PeerReviewEmailDelivery> {
  const email = recipientEmail.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return {
      status: 'not_configured',
      recipientEmail: email,
      reason: 'Recipient email address is unavailable.',
    };
  }

  const config = resolveHiringSmtpConfig();
  if (!config) {
    return {
      status: 'not_configured',
      recipientEmail: email,
      reason:
        'SMTP mail delivery is not configured in this environment; review request is saved in the workspace.',
    };
  }

  try {
    await sendRawSmtp(config, email, rendered);
    return {
      status: 'sent',
      recipientEmail: email,
      ...(config.isLocalMailpit
        ? { inboxUrl: `/r23/mail?email=${encodeURIComponent(email)}` }
        : {}),
    };
  } catch (err) {
    return {
      status: 'failed',
      recipientEmail: email,
      reason:
        err instanceof Error
          ? err.message
          : 'Email delivery failed; review request is saved in the workspace.',
    };
  }
}
