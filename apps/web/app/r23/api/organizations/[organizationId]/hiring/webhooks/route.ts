import { NextResponse } from 'next/server';

import {
  ALLOWED_WEBHOOK_EVENTS,
  generateWebhookSecret,
  sendWebhookPing,
  validateWebhookTargetUrl,
  WebhookSsrfBlockedError,
} from '../../../../../../../src/hiring/webhooks';
import {
  hiringFailureJsonResponse,
  hiringParseJsonBody,
  resolveStagingPublicOrigin,
  StagingBadRequest,
  withHiringOrganizationSession,
} from '../../../../../../../src/staging/browser';
import { recordServerTelemetryEvent } from '../../../../../../../src/telemetry/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sanitizeEventTypes(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new StagingBadRequest();
  const allowed = new Set<string>(ALLOWED_WEBHOOK_EVENTS);
  const filtered = raw
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => allowed.has(entry));
  const unique = Array.from(new Set(filtered));
  if (unique.length === 0) throw new StagingBadRequest();
  return unique;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
): Promise<Response> {
  try {
    const { organizationId } = await params;
    return await withHiringOrganizationSession(
      request,
      organizationId,
      {},
      async ({ dispatch, organizationId: orgId }) => {
        const res = (await dispatch('hiring.webhook.list', {
          organizationId: orgId,
        })) as { webhooks?: unknown[]; deliveries?: unknown[] };
        return NextResponse.json(
          {
            webhooks: res?.webhooks ?? [],
            deliveries: res?.deliveries ?? [],
          },
          { headers: { 'Cache-Control': 'private, no-store' } },
        );
      },
    );
  } catch (error) {
    return hiringFailureJsonResponse(request, error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
): Promise<Response> {
  try {
    const { organizationId } = await params;
    const body = await hiringParseJsonBody(request, 32768);
    const action = String(body.action ?? '').trim();

    return await withHiringOrganizationSession(
      request,
      organizationId,
      { requireOriginCsrf: true, body },
      async ({ dispatch, organizationId: orgId, orgContext, plan }) => {
        if (action === 'create') {
          const label = String(body.label ?? '')
            .trim()
            .slice(0, 80);
          const targetUrl = String(body.targetUrl ?? '').trim();
          const payloadMode =
            body.payloadMode === 'slack_block_kit' ? 'slack_block_kit' : 'json';
          const eventTypes = sanitizeEventTypes(body.eventTypes) ?? [
            ...ALLOWED_WEBHOOK_EVENTS,
          ];

          if (!label || !targetUrl) throw new StagingBadRequest();
          try {
            validateWebhookTargetUrl(targetUrl);
          } catch (error) {
            if (error instanceof WebhookSsrfBlockedError) {
              return NextResponse.json(
                {
                  error: {
                    code: 'INVALID_WEBHOOK_URL',
                    message: error.message,
                  },
                },
                {
                  status: 400,
                  headers: { 'Cache-Control': 'private, no-store' },
                },
              );
            }
            throw error;
          }

          const secret = generateWebhookSecret(orgId);
          const res = (await dispatch('hiring.webhook.upsert', {
            organizationId: orgId,
            input: {
              label,
              targetUrl,
              payloadMode,
              eventTypes,
              signingSecretCiphertext: secret.ciphertext,
              signingSecretPrefix: secret.prefix,
              isActive: true,
            },
          })) as { webhook?: unknown };

          recordServerTelemetryEvent({
            eventName: 'webhook.created',
            category: 'team_funnel',
            actorType: 'team_member',
            organizationId: orgId,
            principalId: orgContext.principalId,
            planTier: plan.planTier,
            route: '/r23/organizations/:id/settings',
            properties: { payloadMode, eventCount: eventTypes.length },
          });

          return NextResponse.json(
            { webhook: res?.webhook ?? null, signingSecret: secret.plaintext },
            { headers: { 'Cache-Control': 'private, no-store' } },
          );
        }

        const webhookId = String(body.webhookId ?? '')
          .trim()
          .toLowerCase();
        if (!UUID_RE.test(webhookId)) throw new StagingBadRequest();

        if (action === 'update') {
          const input: Record<string, unknown> = { webhookId };
          if (typeof body.label === 'string') {
            const cleaned = body.label.trim().slice(0, 80);
            if (!cleaned) throw new StagingBadRequest();
            input.label = cleaned;
          }
          if (typeof body.targetUrl === 'string') {
            const cleanedUrl = body.targetUrl.trim();
            try {
              validateWebhookTargetUrl(cleanedUrl);
            } catch (error) {
              if (error instanceof WebhookSsrfBlockedError) {
                return NextResponse.json(
                  {
                    error: {
                      code: 'INVALID_WEBHOOK_URL',
                      message: error.message,
                    },
                  },
                  {
                    status: 400,
                    headers: { 'Cache-Control': 'private, no-store' },
                  },
                );
              }
              throw error;
            }
            input.targetUrl = cleanedUrl;
          }
          if (
            body.payloadMode === 'json' ||
            body.payloadMode === 'slack_block_kit'
          ) {
            input.payloadMode = body.payloadMode;
          }
          const eventTypes = sanitizeEventTypes(body.eventTypes);
          if (eventTypes) input.eventTypes = eventTypes;
          if (typeof body.isActive === 'boolean') {
            input.isActive = body.isActive;
          }

          const res = (await dispatch('hiring.webhook.upsert', {
            organizationId: orgId,
            input,
          })) as { webhook?: unknown };

          recordServerTelemetryEvent({
            eventName: 'webhook.updated',
            category: 'team_funnel',
            actorType: 'team_member',
            organizationId: orgId,
            principalId: orgContext.principalId,
            planTier: plan.planTier,
            route: '/r23/organizations/:id/settings',
          });

          return NextResponse.json(
            { webhook: res?.webhook ?? null },
            { headers: { 'Cache-Control': 'private, no-store' } },
          );
        }

        if (action === 'rotate') {
          const secret = generateWebhookSecret(orgId);
          const res = (await dispatch('hiring.webhook.upsert', {
            organizationId: orgId,
            input: {
              webhookId,
              signingSecretCiphertext: secret.ciphertext,
              signingSecretPrefix: secret.prefix,
            },
          })) as { webhook?: unknown };

          recordServerTelemetryEvent({
            eventName: 'webhook.updated',
            category: 'team_funnel',
            actorType: 'team_member',
            organizationId: orgId,
            principalId: orgContext.principalId,
            planTier: plan.planTier,
            route: '/r23/organizations/:id/settings',
            properties: { rotatedSecret: true },
          });

          return NextResponse.json(
            { webhook: res?.webhook ?? null, signingSecret: secret.plaintext },
            { headers: { 'Cache-Control': 'private, no-store' } },
          );
        }

        if (action === 'ping') {
          // Enforce CTO/owner authorization through verified staging dispatch before dispatching ping
          await dispatch('hiring.webhook.list', { organizationId: orgId });
          const delivery = await sendWebhookPing(
            orgId,
            webhookId,
            resolveStagingPublicOrigin(request),
          );
          if (!delivery) {
            return NextResponse.json(
              {
                error: {
                  code: 'WEBHOOK_NOT_FOUND',
                  message: 'Webhook endpoint not found.',
                },
              },
              {
                status: 404,
                headers: { 'Cache-Control': 'private, no-store' },
              },
            );
          }

          recordServerTelemetryEvent({
            eventName: 'webhook.ping.sent',
            category: 'team_funnel',
            actorType: 'team_member',
            organizationId: orgId,
            principalId: orgContext.principalId,
            planTier: plan.planTier,
            route: '/r23/organizations/:id/settings',
            status: delivery.status === 'delivered' ? 'ok' : 'error',
          });

          return NextResponse.json(
            { delivery },
            { headers: { 'Cache-Control': 'private, no-store' } },
          );
        }

        if (action === 'delete') {
          await dispatch('hiring.webhook.delete', {
            organizationId: orgId,
            webhookId,
          });

          recordServerTelemetryEvent({
            eventName: 'webhook.deleted',
            category: 'team_funnel',
            actorType: 'team_member',
            organizationId: orgId,
            principalId: orgContext.principalId,
            planTier: plan.planTier,
            route: '/r23/organizations/:id/settings',
          });

          return NextResponse.json(
            { ok: true },
            { headers: { 'Cache-Control': 'private, no-store' } },
          );
        }

        throw new StagingBadRequest();
      },
    );
  } catch (error) {
    return hiringFailureJsonResponse(request, error);
  }
}
