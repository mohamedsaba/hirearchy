'use client';

import { useEffect, useState } from 'react';
import { IconBellRinging, IconClockPause, IconX } from '@tabler/icons-react';

export type OrgNudgeKey =
  | 'unreviewed_submission_48h'
  | 'plan_gate_no_upgrade'
  | 'problem_health_alert'
  | 'no_assessment_48h'
  | 'connect_slack_webhook';

export interface OrgNudgeItem {
  readonly nudgeKey: OrgNudgeKey;
  readonly targetRef: string;
  readonly priority: number;
  readonly title: string;
  readonly detail: string;
  readonly ctaLabel: string;
  readonly ctaHref: string;
  readonly count: number;
}

export const NUDGE_PRIORITY_ORDER: readonly OrgNudgeKey[] = [
  'unreviewed_submission_48h',
  'plan_gate_no_upgrade',
  'problem_health_alert',
  'no_assessment_48h',
  'connect_slack_webhook',
];

export function selectHighestPriorityNudge(
  nudges: readonly OrgNudgeItem[],
): OrgNudgeItem | null {
  if (!Array.isArray(nudges) || nudges.length === 0) return null;
  const rank = (key: OrgNudgeKey): number => {
    const idx = NUDGE_PRIORITY_ORDER.indexOf(key);
    return idx === -1 ? 99 : idx;
  };
  return [...nudges].sort((a, b) => {
    const byRank = rank(a.nudgeKey) - rank(b.nudgeKey);
    if (byRank !== 0) return byRank;
    return (a.priority ?? 99) - (b.priority ?? 99);
  })[0];
}

function readCsrfCookie(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)__Host-r23-csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

export function OrgNudgeBanner({
  organizationId,
}: {
  readonly organizationId: string;
}) {
  const [nudges, setNudges] = useState<OrgNudgeItem[]>([]);
  const [busy, setBusy] = useState(false);

  const apiUrl = `/r23/api/organizations/${encodeURIComponent(organizationId)}/hiring/nudges`;

  useEffect(() => {
    if (typeof fetch !== 'function') return;
    let active = true;
    fetch(apiUrl, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { nudges?: OrgNudgeItem[] } | null) => {
        if (active && Array.isArray(data?.nudges)) {
          setNudges(data.nudges);
        }
      })
      .catch(() => {
        // Gracefully hide when nudges API is unreachable or in static tests.
      });
    return () => {
      active = false;
    };
  }, [apiUrl]);

  const activeNudge = selectHighestPriorityNudge(nudges);
  if (!activeNudge) {
    return null;
  }

  const handleAction = async (action: 'snooze' | 'dismiss') => {
    setBusy(true);
    const csrf = readCsrfCookie();
    try {
      await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify({
          nudgeKey: activeNudge.nudgeKey,
          targetRef: activeNudge.targetRef ?? '',
          action,
        }),
      });
    } catch {
      // Remove optimistically so user isn't stuck with a stale banner.
    } finally {
      setNudges((prev) =>
        prev.filter(
          (item) =>
            !(
              item.nudgeKey === activeNudge.nudgeKey &&
              item.targetRef === activeNudge.targetRef
            ),
        ),
      );
      setBusy(false);
    }
  };

  return (
    <aside
      className="hiring-banner org-nudge-banner"
      role="region"
      aria-label="Workspace recommendation"
      data-nudge-key={activeNudge.nudgeKey}
      data-testid="org-nudge-banner"
    >
      <div className="org-nudge-copy">
        <div className="org-nudge-title-row">
          <IconBellRinging size={16} aria-hidden="true" />
          <strong>{activeNudge.title}</strong>
          {activeNudge.count > 0 ? (
            <span className="hiring-pill hiring-pill-plum">
              {activeNudge.count}
            </span>
          ) : null}
        </div>
        <p className="hiring-muted-copy">{activeNudge.detail}</p>
      </div>
      <div className="org-nudge-actions">
        <a
          className="hiring-btn hiring-btn-sm hiring-btn-primary"
          href={activeNudge.ctaHref}
        >
          {activeNudge.ctaLabel}
        </a>
        <button
          type="button"
          className="hiring-btn hiring-btn-sm"
          disabled={busy}
          onClick={() => void handleAction('snooze')}
        >
          <IconClockPause size={14} aria-hidden="true" /> Snooze 7d
        </button>
        <button
          type="button"
          className="hiring-btn hiring-btn-sm"
          disabled={busy}
          aria-label={`Dismiss ${activeNudge.title}`}
          onClick={() => void handleAction('dismiss')}
        >
          <IconX size={14} aria-hidden="true" /> Dismiss
        </button>
      </div>
    </aside>
  );
}
