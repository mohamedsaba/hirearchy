import {
  PEER_REVIEW_REQUEST_SUBJECT_PREFIX,
  PEER_REVIEW_RESPONSE_SUBJECT_PREFIX,
} from '../hiring/mail';
import type { FounderUatConfiguration } from './founder-uat';
import {
  FOUNDER_UAT_CONFIRMATION_SUBJECT,
  FOUNDER_UAT_RECOVERY_SUBJECT,
  isValidFounderUatEmail,
} from './founder-uat';

const MAX_SEARCH_RESPONSE_BYTES = 256 * 1024;
const MAX_MESSAGE_RESPONSE_BYTES = 512 * 1024;
const MAX_MESSAGES = 25;

export type FounderUatMailKind =
  'confirmation' | 'recovery' | 'peer_review_request' | 'peer_review_response';

export type FounderUatMailSummary = Readonly<{
  id: string;
  recipient: string;
  subject: string;
  receivedAt: string;
  kind: FounderUatMailKind;
}>;

export class FounderUatMailUnavailable extends Error {}
export class FounderUatMailMessageDenied extends Error {}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactRecipient(value: unknown, email: string): boolean {
  return (
    Array.isArray(value) &&
    value.some((entry) => {
      const address = record(entry);
      const recipient =
        typeof address?.Address === 'string'
          ? address.Address
          : typeof address?.Email === 'string'
            ? address.Email
            : null;
      return (
        typeof recipient === 'string' &&
        recipient.trim().toLowerCase() === email
      );
    })
  );
}

function mailKind(subject: unknown): FounderUatMailKind | null {
  if (typeof subject !== 'string') return null;
  const normalized = subject.trim().toLowerCase();
  if (normalized === FOUNDER_UAT_CONFIRMATION_SUBJECT.toLowerCase()) {
    return 'confirmation';
  }
  if (normalized === FOUNDER_UAT_RECOVERY_SUBJECT.toLowerCase()) {
    return 'recovery';
  }
  if (normalized.startsWith(PEER_REVIEW_REQUEST_SUBJECT_PREFIX.toLowerCase())) {
    return 'peer_review_request';
  }
  if (
    normalized.startsWith(PEER_REVIEW_RESPONSE_SUBJECT_PREFIX.toLowerCase())
  ) {
    return 'peer_review_response';
  }
  return null;
}

async function boundedJson(
  response: Response,
  limit: number,
): Promise<unknown> {
  if (!response.ok || !response.body) throw new FounderUatMailUnavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new FounderUatMailUnavailable();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new FounderUatMailUnavailable();
  }
}

async function mailpitJson(
  config: FounderUatConfiguration,
  path: string,
  limit: number,
): Promise<unknown> {
  const url = new URL(path, config.mailpitApiUrl);
  try {
    return await boundedJson(
      await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
      }),
      limit,
    );
  } catch {
    throw new FounderUatMailUnavailable();
  }
}

export async function listFounderUatMessages(
  config: FounderUatConfiguration,
  suppliedEmail: string,
): Promise<FounderUatMailSummary[]> {
  if (!isValidFounderUatEmail(suppliedEmail)) {
    throw new FounderUatMailMessageDenied();
  }
  const email = suppliedEmail.trim().toLowerCase();
  const search = new URLSearchParams({
    query: `to:"${email}"`,
    start: '0',
    limit: String(MAX_MESSAGES),
  });
  const result = record(
    await mailpitJson(
      config,
      `/api/v1/search?${search.toString()}`,
      MAX_SEARCH_RESPONSE_BYTES,
    ),
  );
  if (!Array.isArray(result?.messages)) throw new FounderUatMailUnavailable();

  return result.messages.slice(0, MAX_MESSAGES).flatMap((value) => {
    const message = record(value);
    const kind = mailKind(message?.Subject);
    if (
      typeof message?.ID !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(message.ID) ||
      !kind ||
      !exactRecipient(message.To, email) ||
      typeof message.Created !== 'string' ||
      !Number.isFinite(Date.parse(message.Created)) ||
      typeof message.Subject !== 'string'
    ) {
      return [];
    }
    return [
      Object.freeze({
        id: message.ID,
        recipient: email,
        subject: message.Subject.slice(0, 200).replace(
          /[\r\n\u0000-\u001f]/g,
          '',
        ),
        receivedAt: new Date(message.Created).toISOString(),
        kind,
      }),
    ];
  });
}

export async function readFounderUatMessageAction(
  config: FounderUatConfiguration,
  emailValue: string,
  messageId: string,
): Promise<
  | { kind: 'confirmation' | 'recovery'; otp: string }
  | {
      kind: 'peer_review_request' | 'peer_review_response';
      reviewPath: string;
    }
> {
  if (
    !isValidFounderUatEmail(emailValue) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(messageId)
  ) {
    throw new FounderUatMailMessageDenied();
  }
  const email = emailValue.trim().toLowerCase();
  const message = record(
    await mailpitJson(
      config,
      `/api/v1/message/${encodeURIComponent(messageId)}`,
      MAX_MESSAGE_RESPONSE_BYTES,
    ),
  );
  const kind = mailKind(message?.Subject);
  if (
    !message ||
    message.ID !== messageId ||
    !kind ||
    !exactRecipient(message.To, email) ||
    typeof message.Text !== 'string'
  ) {
    throw new FounderUatMailMessageDenied();
  }

  if (kind === 'peer_review_request' || kind === 'peer_review_response') {
    const expectedOrigin = config.appOrigin.origin;
    const match = message.Text.match(
      /https?:\/\/[^\s"'<>]+\/r27\/organizations\/[0-9a-f-]{36}\/sessions\/sess_[A-Za-z0-9_-]+(?:\?[^\s"'<>]*)?/i,
    );
    if (!match) throw new FounderUatMailMessageDenied();
    let parsed: URL;
    try {
      parsed = new URL(match[0]);
    } catch {
      throw new FounderUatMailMessageDenied();
    }
    if (parsed.origin !== expectedOrigin) {
      throw new FounderUatMailMessageDenied();
    }
    return { kind, reviewPath: `${parsed.pathname}${parsed.search}` };
  }

  const codes = message.Text.match(/(?<!\d)\d{6}(?!\d)/g) ?? [];
  if (codes.length !== 1) throw new FounderUatMailMessageDenied();
  return { kind, otp: codes[0] };
}

export async function readFounderUatMessageOtp(
  config: FounderUatConfiguration,
  emailValue: string,
  messageId: string,
): Promise<{ kind: 'confirmation' | 'recovery'; otp: string }> {
  const action = await readFounderUatMessageAction(
    config,
    emailValue,
    messageId,
  );
  if (action.kind !== 'confirmation' && action.kind !== 'recovery') {
    throw new FounderUatMailMessageDenied();
  }
  return action;
}
