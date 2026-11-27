'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  IconCopy,
  IconKey,
  IconPlayerPause,
  IconPlayerPlay,
  IconSend,
  IconTrash,
  IconWebhook,
} from '@tabler/icons-react';

export type WebhookPayloadMode = 'json' | 'slack_block_kit';

export const WEBHOOK_EVENT_OPTIONS = [
  { id: 'candidate.started', label: 'Candidate started' },
  { id: 'candidate.submitted', label: 'Candidate submitted' },
  { id: 'verdict.published', label: 'Verdict published' },
  { id: 'handoff.updated', label: 'Handoff updated' },
] as const;

export interface OrgWebhookRecord {
  readonly id: string;
  readonly label: string;
  readonly targetUrl: string;
  readonly payloadMode: WebhookPayloadMode;
  readonly eventTypes: readonly string[];
  readonly signingSecretPrefix: string;
  readonly isActive: boolean;
  readonly consecutiveFailures: number;
  readonly disabledReason: string;
  readonly lastDeliveredAt: string | null;
  readonly createdAt: string;
}

export interface OrgWebhookDeliveryRecord {
  readonly id: string;
  readonly webhookId: string;
  readonly eventType: string;
  readonly status: string;
  readonly httpStatus: number | null;
  readonly latencyMs: number | null;
  readonly errorSummary: string;
  readonly createdAt: string;
}

function readCsrfCookie(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)__Host-r23-csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function deliveryStatusPillClass(status: string): string {
  if (status === 'delivered') return 'hiring-pill hiring-pill-success';
  if (status === 'failed' || status === 'blocked_ssrf') {
    return 'hiring-pill hiring-pill-danger';
  }
  return 'hiring-pill hiring-pill-warning';
}

export function OrgWebhooksPanel({
  organizationId,
  csrfToken,
}: {
  readonly organizationId: string;
  readonly csrfToken?: string;
}) {
  const [webhooks, setWebhooks] = useState<OrgWebhookRecord[]>([]);
  const [deliveries, setDeliveries] = useState<OrgWebhookDeliveryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  const [label, setLabel] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [payloadMode, setPayloadMode] = useState<WebhookPayloadMode>('json');
  const [selectedEvents, setSelectedEvents] = useState<string[]>(
    WEBHOOK_EVENT_OPTIONS.map((opt) => opt.id),
  );

  const apiUrl = `/r23/api/organizations/${encodeURIComponent(organizationId)}/hiring/webhooks`;

  const fetchWebhooksData = useCallback(async () => {
    const res = await fetch(apiUrl, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(err?.error?.message ?? 'Unable to load webhooks.');
    }
    return (await res.json()) as {
      webhooks?: OrgWebhookRecord[];
      deliveries?: OrgWebhookDeliveryRecord[];
    };
  }, [apiUrl]);

  const loadWebhooks = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchWebhooksData();
      setWebhooks(data.webhooks ?? []);
      setDeliveries(data.deliveries ?? []);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to load webhooks.',
      );
    } finally {
      setLoading(false);
    }
  }, [fetchWebhooksData]);

  useEffect(() => {
    if (typeof fetch !== 'function') return;
    let active = true;
    fetchWebhooksData()
      .then((data) => {
        if (!active) return;
        setWebhooks(data.webhooks ?? []);
        setDeliveries(data.deliveries ?? []);
        setError(null);
      })
      .catch((cause) => {
        if (!active) return;
        setError(
          cause instanceof Error ? cause.message : 'Unable to load webhooks.',
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [fetchWebhooksData]);

  const postAction = async (payload: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    setStatusMsg(null);
    const csrf = csrfToken || readCsrfCookie();
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => null)) as {
        webhook?: OrgWebhookRecord;
        signingSecret?: string;
        delivery?: OrgWebhookDeliveryRecord;
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        throw new Error(data?.error?.message ?? 'Webhook operation failed.');
      }
      if (data?.signingSecret) {
        setRevealedSecret(data.signingSecret);
      }
      if (payload.action === 'ping' && data?.delivery) {
        setStatusMsg(
          `Test ping ${data.delivery.status}${data.delivery.httpStatus ? ` (HTTP ${data.delivery.httpStatus})` : ''}${data.delivery.latencyMs !== null ? ` in ${data.delivery.latencyMs}ms` : ''}.`,
        );
      } else if (payload.action === 'create') {
        setLabel('');
        setTargetUrl('');
        setStatusMsg('Webhook endpoint created.');
      } else if (payload.action === 'rotate') {
        setStatusMsg('Signing secret rotated.');
      } else if (payload.action === 'delete') {
        setStatusMsg('Webhook removed.');
      } else {
        setStatusMsg('Webhook updated.');
      }
      await loadWebhooks();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Webhook operation failed.',
      );
    } finally {
      setBusy(false);
    }
  };

  const toggleEvent = (eventId: string) => {
    setSelectedEvents((prev) =>
      prev.includes(eventId)
        ? prev.filter((item) => item !== eventId)
        : [...prev, eventId],
    );
  };

  return (
    <section
      id="webhooks"
      className="hiring-card org-webhooks-panel"
      aria-labelledby="org-webhooks-heading"
    >
      <div className="org-benchmarks-header">
        <div>
          <span className="hiring-eyebrow">
            <IconWebhook size={13} aria-hidden="true" /> Integrations
          </span>
          <h2 id="org-webhooks-heading">Webhooks &amp; Slack alerts</h2>
          <p className="hiring-muted-copy">
            Receive real-time HMAC-signed JSON events or Slack Block Kit alerts
            when candidates start, submit, or receive a verdict.
          </p>
        </div>
      </div>

      {revealedSecret ? (
        <div
          className="hiring-banner hiring-banner-success org-webhook-secret-banner"
          role="status"
        >
          <div>
            <strong>Copy your signing secret now</strong>
            <p className="hiring-muted-copy">
              This secret will only be shown once. Verify{' '}
              <code>X-Hirearchy-Signature</code> with HMAC-SHA256.
            </p>
            <code className="org-webhook-secret-value">{revealedSecret}</code>
          </div>
          <div className="hiring-header-actions">
            <button
              type="button"
              className="hiring-btn hiring-btn-sm hiring-btn-primary"
              onClick={() => {
                void navigator.clipboard?.writeText(revealedSecret);
                setStatusMsg('Signing secret copied.');
              }}
            >
              <IconCopy size={14} aria-hidden="true" /> Copy secret
            </button>
            <button
              type="button"
              className="hiring-btn hiring-btn-sm"
              onClick={() => setRevealedSecret(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="hiring-banner hiring-banner-danger" role="alert">
          <span>{error}</span>
        </div>
      ) : null}
      {statusMsg ? (
        <div className="hiring-banner hiring-banner-success" role="status">
          <span>{statusMsg}</span>
        </div>
      ) : null}

      <form
        className="org-webhook-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          void postAction({
            action: 'create',
            label: label.trim(),
            targetUrl: targetUrl.trim(),
            payloadMode,
            eventTypes: selectedEvents,
          });
        }}
      >
        <div className="hiring-two-col">
          <div className="hiring-field">
            <label htmlFor="webhook-label">Endpoint label</label>
            <input
              id="webhook-label"
              type="text"
              required
              maxLength={80}
              placeholder="e.g. #hiring-alerts Slack"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="hiring-field">
            <label htmlFor="webhook-url">HTTPS endpoint URL</label>
            <input
              id="webhook-url"
              type="url"
              required
              maxLength={500}
              placeholder="https://hooks.slack.com/services/..."
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
            />
          </div>
        </div>
        <div className="hiring-two-col">
          <div className="hiring-field">
            <label htmlFor="webhook-mode">Payload format</label>
            <select
              id="webhook-mode"
              value={payloadMode}
              onChange={(e) =>
                setPayloadMode(e.target.value as WebhookPayloadMode)
              }
            >
              <option value="json">Standard JSON (HMAC-SHA256)</option>
              <option value="slack_block_kit">
                Slack Incoming Webhook (Block Kit)
              </option>
            </select>
          </div>
          <fieldset className="hiring-field org-webhook-events-fieldset">
            <legend>Subscribed events</legend>
            <div className="org-webhook-event-checks">
              {WEBHOOK_EVENT_OPTIONS.map((opt) => (
                <label key={opt.id} className="org-webhook-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedEvents.includes(opt.id)}
                    onChange={() => toggleEvent(opt.id)}
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <div>
          <button
            type="submit"
            className="hiring-btn hiring-btn-primary"
            disabled={busy || selectedEvents.length === 0}
          >
            Add webhook endpoint
          </button>
        </div>
      </form>

      {loading ? (
        <p className="hiring-muted-copy">Loading webhooks…</p>
      ) : webhooks.length === 0 ? (
        <p className="hiring-muted-copy">
          No webhooks configured yet. Add a Slack incoming webhook or JSON
          endpoint above.
        </p>
      ) : (
        <div className="org-webhook-list">
          {webhooks.map((hook) => (
            <article
              key={hook.id}
              className="hiring-card-subtle org-webhook-card"
            >
              <div className="org-webhook-card-head">
                <div>
                  <div className="hiring-candidate-name">
                    <strong>{hook.label}</strong>
                    <span
                      className={`hiring-pill ${hook.isActive ? 'hiring-pill-success' : 'hiring-pill-warning'}`}
                    >
                      {hook.isActive ? 'Active' : 'Paused'}
                    </span>
                    <span className="hiring-pill hiring-pill-plum">
                      {hook.payloadMode === 'slack_block_kit'
                        ? 'Slack Block Kit'
                        : 'JSON HMAC'}
                    </span>
                  </div>
                  <p className="hiring-muted-copy org-webhook-url">
                    <code>{hook.targetUrl}</code> · Secret{' '}
                    <code>{hook.signingSecretPrefix}</code>
                  </p>
                  <p className="hiring-muted-copy">
                    Events: {hook.eventTypes.join(', ')}
                    {hook.disabledReason
                      ? ` · Disabled: ${hook.disabledReason}`
                      : ''}
                  </p>
                </div>
                <div className="hiring-header-actions">
                  <button
                    type="button"
                    className="hiring-btn hiring-btn-sm"
                    disabled={busy}
                    onClick={() =>
                      void postAction({ action: 'ping', webhookId: hook.id })
                    }
                  >
                    <IconSend size={14} aria-hidden="true" /> Test ping
                  </button>
                  <button
                    type="button"
                    className="hiring-btn hiring-btn-sm"
                    disabled={busy}
                    onClick={() =>
                      void postAction({
                        action: 'update',
                        webhookId: hook.id,
                        isActive: !hook.isActive,
                      })
                    }
                  >
                    {hook.isActive ? (
                      <>
                        <IconPlayerPause size={14} aria-hidden="true" /> Pause
                      </>
                    ) : (
                      <>
                        <IconPlayerPlay size={14} aria-hidden="true" /> Resume
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    className="hiring-btn hiring-btn-sm"
                    disabled={busy}
                    onClick={() =>
                      void postAction({ action: 'rotate', webhookId: hook.id })
                    }
                  >
                    <IconKey size={14} aria-hidden="true" /> Rotate secret
                  </button>
                  <button
                    type="button"
                    className="hiring-btn hiring-btn-sm team-danger-btn"
                    disabled={busy}
                    onClick={() =>
                      void postAction({ action: 'delete', webhookId: hook.id })
                    }
                  >
                    <IconTrash size={14} aria-hidden="true" /> Delete
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {deliveries.length > 0 ? (
        <div className="org-deliveries-section">
          <h3>Recent deliveries</h3>
          <div className="software-overflow-region" tabIndex={0}>
            <table className="software-members-table org-deliveries-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Status</th>
                  <th>HTTP</th>
                  <th>Latency</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.slice(0, 15).map((d) => (
                  <tr key={d.id}>
                    <td>
                      <code>{d.eventType}</code>
                    </td>
                    <td>
                      <span className={deliveryStatusPillClass(d.status)}>
                        {d.status}
                      </span>
                    </td>
                    <td>{d.httpStatus ?? '—'}</td>
                    <td>{d.latencyMs !== null ? `${d.latencyMs}ms` : '—'}</td>
                    <td>{d.errorSummary || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
