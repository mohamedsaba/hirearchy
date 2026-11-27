import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Pool } from 'pg';

import { operationalLogger, sanitizeError } from '../observability/logger.mjs';
import { loadCandidateTokenEncryptionKey } from '../sessions/candidate-token-storage.mjs';

export type WebhookPayloadMode = 'json' | 'slack_block_kit';

export type WebhookEventType =
  | 'webhook.ping'
  | 'candidate.started'
  | 'candidate.submitted'
  | 'verdict.published'
  | 'handoff.updated';

export const ALLOWED_WEBHOOK_EVENTS: readonly Exclude<
  WebhookEventType,
  'webhook.ping'
>[] = [
  'candidate.started',
  'candidate.submitted',
  'verdict.published',
  'handoff.updated',
];

export interface EnqueuedWebhookDelivery {
  readonly deliveryId: string;
  readonly webhookId: string;
  readonly organizationId: string;
  readonly targetUrl: string;
  readonly payloadMode: WebhookPayloadMode;
  readonly signingSecretCiphertext: string;
  readonly eventId: string;
  readonly eventType: WebhookEventType;
  readonly sessionId: string | null;
  readonly payload: Record<string, unknown>;
}

export interface WebhookDeliveryResult {
  readonly id: string;
  readonly webhookId: string;
  readonly eventType: WebhookEventType;
  readonly status: 'delivered' | 'failed' | 'blocked_ssrf' | 'pending';
  readonly httpStatus: number | null;
  readonly latencyMs: number | null;
  readonly errorSummary: string;
  readonly createdAt: string;
}

const SLACK_MAX_PAYLOAD_BYTES = 150 * 1024;
const DELIVERY_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 4096;

const PRIVATE_NET_BLOCKLIST = (() => {
  const list = new BlockList();
  list.addSubnet('127.0.0.0', 8, 'ipv4');
  list.addSubnet('10.0.0.0', 8, 'ipv4');
  list.addSubnet('172.16.0.0', 12, 'ipv4');
  list.addSubnet('192.168.0.0', 16, 'ipv4');
  list.addSubnet('169.254.0.0', 16, 'ipv4');
  list.addSubnet('0.0.0.0', 8, 'ipv4');
  list.addSubnet('100.64.0.0', 10, 'ipv4');
  list.addSubnet('224.0.0.0', 4, 'ipv4');
  list.addSubnet('240.0.0.0', 4, 'ipv4');
  list.addAddress('::1', 'ipv6');
  list.addAddress('::', 'ipv6');
  list.addSubnet('fc00::', 7, 'ipv6');
  list.addSubnet('fe80::', 10, 'ipv6');
  list.addSubnet('ff00::', 8, 'ipv6');
  list.addSubnet('::ffff:0:0', 96, 'ipv6');
  return list;
})();

let webhookPool: Pool | null = null;
let configuredWebhookDbUrl: string | undefined;

function getWebhookPool(): Pool | null {
  const databaseUrl = process.env.STAGING_DATABASE_URL?.trim();
  if (!databaseUrl) return null;

  if (!webhookPool || configuredWebhookDbUrl !== databaseUrl) {
    configuredWebhookDbUrl = databaseUrl;
    webhookPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10000,
      statement_timeout: 4000,
    });
    const emitter = webhookPool as unknown as {
      on?: (event: string, cb: (err: unknown) => void) => void;
    };
    emitter.on?.('error', (error: unknown) => {
      operationalLogger.warn('Webhook PostgreSQL pool idle error', {
        service: 'hiring_webhooks',
        error: sanitizeError(error),
      });
    });
  }
  return webhookPool;
}

function deriveWebhookSubkey(
  organizationId: string,
  masterKey: Buffer = loadCandidateTokenEncryptionKey(),
): Buffer {
  const raw = hkdfSync(
    'sha256',
    masterKey,
    Buffer.from(organizationId, 'utf8'),
    Buffer.from('hirearchy-webhook-secret-v1', 'utf8'),
    32,
  );
  return Buffer.from(raw);
}

export function generateWebhookSecret(
  organizationId: string,
  masterKey?: Buffer,
): {
  plaintext: string;
  prefix: string;
  ciphertext: string;
} {
  const plaintext = `whsec_${randomBytes(24).toString('base64url')}`;
  const prefix = `${plaintext.slice(0, 12)}...`;
  const ciphertext = encryptWebhookSecret(organizationId, plaintext, masterKey);
  return { plaintext, prefix, ciphertext };
}

export function encryptWebhookSecret(
  organizationId: string,
  plaintextSecret: string,
  masterKey?: Buffer,
): string {
  const key = deriveWebhookSubkey(organizationId, masterKey);
  const iv = randomBytes(12);
  const aad = Buffer.from(
    `hirearchy-webhook-secret-v1:${organizationId}`,
    'utf8',
  );
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([
    cipher.update(plaintextSecret, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptWebhookSecret(
  organizationId: string,
  ciphertext: string,
  masterKey?: Buffer,
): string {
  const parts = ciphertext.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Invalid webhook secret envelope');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const data = Buffer.from(dataB64, 'base64url');
  const key = deriveWebhookSubkey(organizationId, masterKey);
  const aad = Buffer.from(
    `hirearchy-webhook-secret-v1:${organizationId}`,
    'utf8',
  );
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    'utf8',
  );
}

export function signWebhookPayload(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  const digest = createHmac('sha256', secret)
    .update(`v0:${timestampSeconds}:${rawBody}`, 'utf8')
    .digest('hex');
  return `v0=${digest}`;
}

export class WebhookSsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSsrfBlockedError';
  }
}

function isBlockedIp(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '');
  const family = isIP(bare);
  if (family === 4) {
    return PRIVATE_NET_BLOCKLIST.check(bare, 'ipv4');
  }
  if (family === 6) {
    if (PRIVATE_NET_BLOCKLIST.check(bare, 'ipv6')) return true;
    if (bare.toLowerCase().startsWith('::ffff:')) {
      const mapped = bare.slice(7);
      if (isIP(mapped) === 4) {
        return PRIVATE_NET_BLOCKLIST.check(mapped, 'ipv4');
      }
    }
    return false;
  }
  return true;
}

function isLoopbackIp(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '');
  if (bare === '::1') return true;
  if (isIP(bare) === 4) {
    return bare.startsWith('127.');
  }
  return false;
}

export function validateWebhookTargetUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebhookSsrfBlockedError('Invalid webhook target URL.');
  }
  const allowLoopback =
    process.env.HIREARCHY_ALLOW_LOOPBACK_WEBHOOKS === 'true';
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (url.username || url.password || url.hash) {
    throw new WebhookSsrfBlockedError(
      'Webhook URL must not contain credentials or fragments.',
    );
  }

  if (url.protocol === 'https:') {
    // Allowed
  } else if (
    url.protocol === 'http:' &&
    allowLoopback &&
    (hostname === 'localhost' || isLoopbackIp(hostname))
  ) {
    // Allowed only in explicit local loopback test mode
  } else {
    throw new WebhookSsrfBlockedError('Webhook URL must use HTTPS.');
  }

  if (
    hostname === 'metadata.google.internal' ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local')
  ) {
    if (!(allowLoopback && hostname === 'localhost')) {
      throw new WebhookSsrfBlockedError('Internal webhook host is blocked.');
    }
  }

  if (isIP(hostname) !== 0) {
    const blocked = isBlockedIp(hostname);
    if (blocked && !(allowLoopback && isLoopbackIp(hostname))) {
      throw new WebhookSsrfBlockedError('Private or loopback IP is blocked.');
    }
  }

  return url;
}

export async function resolvePinnedWebhookAddress(
  url: URL,
): Promise<{ address: string; family: 4 | 6 }> {
  const allowLoopback =
    process.env.HIREARCHY_ALLOW_LOOPBACK_WEBHOOKS === 'true';
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (isBlockedIp(hostname) && !(allowLoopback && isLoopbackIp(hostname))) {
      throw new WebhookSsrfBlockedError('Private or loopback IP is blocked.');
    }
    return { address: hostname, family: literalFamily };
  }

  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  if (!records || records.length === 0) {
    throw new WebhookSsrfBlockedError(
      'Webhook hostname could not be resolved.',
    );
  }
  for (const rec of records) {
    if (
      isBlockedIp(rec.address) &&
      !(allowLoopback && isLoopbackIp(rec.address))
    ) {
      throw new WebhookSsrfBlockedError(
        'Webhook hostname resolves to a private or reserved network.',
      );
    }
  }
  const first = records[0];
  return {
    address: first.address,
    family: first.family === 6 ? 6 : 4,
  };
}

export function formatSlackBlockKitPayload(
  eventType: WebhookEventType,
  payload: Record<string, unknown>,
  publicOrigin = process.env.STAGING_PUBLIC_ORIGIN ||
    'https://hirearchy.software',
): { text: string; blocks: unknown[] } {
  const orgId = String(payload.organizationId ?? '');
  const orgName = String(payload.organizationName ?? 'Hirearchy Workspace');
  const sessionId = payload.sessionId ? String(payload.sessionId) : '';
  const scenarioTitle = String(
    payload.scenarioTitle ?? 'Engineering Assessment',
  );
  const targetRole = String(payload.targetRole ?? 'Software Engineer');
  const decision = payload.decision ? String(payload.decision) : '';
  const nextStageLabel = payload.nextStageLabel
    ? String(payload.nextStageLabel)
    : '';
  const handoffStatus = payload.handoffStatus
    ? String(payload.handoffStatus)
    : '';

  const headlineMap: Record<WebhookEventType, string> = {
    'webhook.ping': `Webhook test ping from ${orgName}`,
    'candidate.started': `Candidate started assessment: ${scenarioTitle}`,
    'candidate.submitted': `Candidate submitted work: ${scenarioTitle}`,
    'verdict.published': `Verdict published (${decision || 'updated'}): ${scenarioTitle}`,
    'handoff.updated': `Handoff updated (${handoffStatus || 'updated'}): ${scenarioTitle}`,
  };

  const title = headlineMap[eventType];
  const origin = publicOrigin.replace(/\/$/, '');
  const actionUrl =
    eventType === 'webhook.ping'
      ? `${origin}/r23/organizations/${encodeURIComponent(orgId)}/settings`
      : eventType === 'handoff.updated'
        ? `${origin}/r23/organizations/${encodeURIComponent(orgId)}/handoffs/${encodeURIComponent(sessionId)}`
        : `${origin}/r27/organizations/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(sessionId)}`;

  const fields: { type: string; text: string }[] = [
    { type: 'mrkdwn', text: `*Workspace:*\n${orgName}` },
    { type: 'mrkdwn', text: `*Role:*\n${targetRole || 'Software Engineer'}` },
  ];
  if (sessionId) {
    fields.push({ type: 'mrkdwn', text: `*Session:*\n\`${sessionId}\`` });
  }
  if (decision) {
    fields.push({ type: 'mrkdwn', text: `*Verdict:*\n${decision}` });
  }
  if (nextStageLabel) {
    fields.push({ type: 'mrkdwn', text: `*Next Stage:*\n${nextStageLabel}` });
  }
  if (handoffStatus && eventType === 'handoff.updated') {
    fields.push({
      type: 'mrkdwn',
      text: `*Handoff Status:*\n${handoffStatus}`,
    });
  }

  const slackPayload = {
    text: title,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: title.slice(0, 150) },
      },
      {
        type: 'section',
        fields: fields.slice(0, 10),
      },
      ...(orgId
        ? [
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: {
                    type: 'plain_text',
                    text:
                      eventType === 'webhook.ping'
                        ? 'Open Workspace Settings'
                        : 'Open Evidence & Review',
                  },
                  url: actionUrl,
                },
              ],
            },
          ]
        : []),
    ],
  };

  if (
    Buffer.byteLength(JSON.stringify(slackPayload), 'utf8') >
    SLACK_MAX_PAYLOAD_BYTES
  ) {
    return {
      text: title.slice(0, 300),
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*${title.slice(0, 300)}*` },
        },
      ],
    };
  }

  return slackPayload;
}

export async function deliverWebhookRequest(input: {
  targetUrl: string;
  payloadMode: WebhookPayloadMode;
  signingSecret: string;
  eventId: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
  publicOrigin?: string;
  timeoutMs?: number;
}): Promise<{
  status: 'delivered' | 'failed' | 'blocked_ssrf';
  httpStatus: number | null;
  latencyMs: number;
  errorSummary: string;
}> {
  const startedAt = Date.now();
  let url: URL;
  let pinned: { address: string; family: 4 | 6 };

  try {
    url = validateWebhookTargetUrl(input.targetUrl);
    pinned = await resolvePinnedWebhookAddress(url);
  } catch (error) {
    return {
      status:
        error instanceof WebhookSsrfBlockedError ? 'blocked_ssrf' : 'failed',
      httpStatus: null,
      latencyMs: Math.max(0, Date.now() - startedAt),
      errorSummary:
        error instanceof Error
          ? error.message.slice(0, 400)
          : 'Webhook target blocked',
    };
  }

  const bodyObj =
    input.payloadMode === 'slack_block_kit'
      ? formatSlackBlockKitPayload(
          input.eventType,
          input.payload,
          input.publicOrigin,
        )
      : input.payload;
  const rawBody = JSON.stringify(bodyObj);
  const timestampSec = Math.floor(Date.now() / 1000);
  const signature = signWebhookPayload(
    input.signingSecret,
    timestampSec,
    rawBody,
  );
  const timeoutMs = input.timeoutMs ?? DELIVERY_TIMEOUT_MS;

  return await new Promise((resolve) => {
    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (result: {
      status: 'delivered' | 'failed' | 'blocked_ssrf';
      httpStatus: number | null;
      errorSummary: string;
    }) => {
      if (settled) return;
      settled = true;
      resolve({
        ...result,
        latencyMs: Math.max(0, Date.now() - startedAt),
      });
    };

    const req = transport.request(
      url,
      {
        method: 'POST',
        timeout: timeoutMs,
        lookup: ((_hostname: string, opts: unknown, cb: unknown) => {
          const all =
            typeof opts === 'object' &&
            opts !== null &&
            (opts as { all?: boolean }).all === true;
          if (all) {
            (
              cb as (
                err: NodeJS.ErrnoException | null,
                addresses: { address: string; family: number }[],
              ) => void
            )(null, [{ address: pinned.address, family: pinned.family }]);
          } else {
            (
              cb as (
                err: NodeJS.ErrnoException | null,
                address: string,
                family: number,
              ) => void
            )(null, pinned.address, pinned.family);
          }
        }) as unknown as typeof import('node:dns').lookup,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': String(Buffer.byteLength(rawBody, 'utf8')),
          'User-Agent': 'Hirearchy-Webhooks/1.0',
          'X-Hirearchy-Event': input.eventType,
          'X-Hirearchy-Delivery': input.eventId,
          'X-Hirearchy-Timestamp': String(timestampSec),
          'X-Hirearchy-Signature': signature,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes <= MAX_RESPONSE_BYTES) {
            chunks.push(chunk);
          }
        });
        res.on('end', () => {
          const code = res.statusCode ?? 0;
          if (code >= 200 && code < 300) {
            finish({ status: 'delivered', httpStatus: code, errorSummary: '' });
          } else {
            const snippet = Buffer.concat(chunks)
              .toString('utf8')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 200);
            finish({
              status: 'failed',
              httpStatus: code,
              errorSummary: snippet
                ? `HTTP ${code}: ${snippet}`.slice(0, 400)
                : `HTTP ${code}`,
            });
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.on('error', (err) => {
      finish({
        status: 'failed',
        httpStatus: null,
        errorSummary: err.message.slice(0, 400),
      });
    });

    req.write(rawBody);
    req.end();
  });
}

async function markDeliveryResult(
  pool: Pool,
  deliveryId: string,
  result: {
    status: 'delivered' | 'failed' | 'blocked_ssrf';
    httpStatus: number | null;
    latencyMs: number;
    errorSummary: string;
  },
): Promise<void> {
  try {
    await pool.query(
      'SELECT staging.webhook_mark_delivery($1::pg_catalog.uuid, $2, $3::pg_catalog.int4, $4::pg_catalog.int4, $5, $6::pg_catalog.timestamptz)',
      [
        deliveryId,
        result.status,
        result.httpStatus,
        result.latencyMs,
        result.errorSummary,
        null,
      ],
    );
  } catch (error) {
    operationalLogger.warn('Failed to mark webhook delivery status', {
      service: 'hiring_webhooks',
      error: sanitizeError(error),
    });
  }
}

async function dispatchEnqueuedItem(
  pool: Pool,
  item: EnqueuedWebhookDelivery,
  publicOrigin?: string,
): Promise<WebhookDeliveryResult> {
  let secret: string;
  try {
    secret = decryptWebhookSecret(
      item.organizationId,
      item.signingSecretCiphertext,
    );
  } catch (error) {
    const failed = {
      status: 'failed' as const,
      httpStatus: null,
      latencyMs: 0,
      errorSummary:
        error instanceof Error
          ? error.message.slice(0, 400)
          : 'Unable to decrypt webhook secret',
    };
    await markDeliveryResult(pool, item.deliveryId, failed);
    return {
      id: item.deliveryId,
      webhookId: item.webhookId,
      eventType: item.eventType,
      status: failed.status,
      httpStatus: null,
      latencyMs: 0,
      errorSummary: failed.errorSummary,
      createdAt: new Date().toISOString(),
    };
  }

  const outcome = await deliverWebhookRequest({
    targetUrl: item.targetUrl,
    payloadMode: item.payloadMode,
    signingSecret: secret,
    eventId: item.eventId,
    eventType: item.eventType,
    payload: item.payload,
    publicOrigin,
  });

  await markDeliveryResult(pool, item.deliveryId, outcome);

  return {
    id: item.deliveryId,
    webhookId: item.webhookId,
    eventType: item.eventType,
    status: outcome.status,
    httpStatus: outcome.httpStatus,
    latencyMs: outcome.latencyMs,
    errorSummary: outcome.errorSummary,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Enqueues and dispatches outbound webhooks for a candidate/hiring session event.
 * Strictly non-blocking/fail-safe: logs warnings on transport/DB failures without throwing.
 */
export async function dispatchSessionWebhookEvent(
  sessionId: string,
  eventType: Exclude<WebhookEventType, 'webhook.ping'>,
  extraPayload: Record<string, unknown> = {},
  publicOrigin?: string,
): Promise<WebhookDeliveryResult[]> {
  const pool = getWebhookPool();
  if (!pool) return [];

  try {
    const res = await pool.query<{ result: EnqueuedWebhookDelivery[] }>(
      'SELECT staging.webhook_enqueue_session_event($1, $2, $3::pg_catalog.jsonb) AS result',
      [sessionId, eventType, JSON.stringify(extraPayload)],
    );
    const items = Array.isArray(res.rows[0]?.result) ? res.rows[0].result : [];
    if (items.length === 0) return [];
    return await Promise.all(
      items.map((item) => dispatchEnqueuedItem(pool, item, publicOrigin)),
    );
  } catch (error) {
    operationalLogger.warn('Failed to dispatch session webhook event', {
      service: 'hiring_webhooks',
      eventType,
      error: sanitizeError(error),
    });
    return [];
  }
}

export function triggerSessionWebhookEvent(
  sessionId: string,
  eventType: Exclude<WebhookEventType, 'webhook.ping'>,
  extraPayload: Record<string, unknown> = {},
  publicOrigin?: string,
): void {
  void dispatchSessionWebhookEvent(
    sessionId,
    eventType,
    extraPayload,
    publicOrigin,
  ).catch(() => []);
}

export async function sendWebhookPing(
  organizationId: string,
  webhookId: string,
  publicOrigin?: string,
): Promise<WebhookDeliveryResult | null> {
  const pool = getWebhookPool();
  if (!pool) return null;

  const res = await pool.query<{ result: EnqueuedWebhookDelivery | null }>(
    'SELECT staging.webhook_enqueue_ping($1::pg_catalog.uuid, $2::pg_catalog.uuid) AS result',
    [organizationId, webhookId],
  );
  const item = res.rows[0]?.result;
  if (!item) return null;
  return await dispatchEnqueuedItem(pool, item, publicOrigin);
}
