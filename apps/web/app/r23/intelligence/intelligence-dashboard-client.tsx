'use client';

import { useState } from 'react';
import {
  IconActivityHeartbeat,
  IconBolt,
  IconChartBar,
  IconClock,
  IconDownload,
  IconMessageStar,
  IconRefresh,
  IconRepeat,
  IconSparkles,
  IconTrendingUp,
} from '@tabler/icons-react';

import type {
  LifecycleActionQueueItem,
  NudgeKey,
  ProductIntelligenceReport,
  ProductLifecycleReport,
} from '../../../src/telemetry/catalog';
import { emitToast } from '../../_components/brand-toast';
import { CopyActionButton } from '../../_components/copy-action-button';
import { HorizontalTabs } from '../../_components/horizontal-tabs';

const HEALTH_BADGE_MAP: Readonly<
  Record<
    ProductIntelligenceReport['assessmentHealth'][number]['healthFlag'],
    { label: string; className: string }
  >
> = {
  healthy: { label: 'Healthy', className: 'hiring-pill hiring-pill-success' },
  high_dropoff: {
    label: 'High drop-off',
    className: 'hiring-pill hiring-pill-danger',
  },
  runner_errors: {
    label: 'Runner errors',
    className: 'hiring-pill hiring-pill-danger',
  },
  time_pressure: {
    label: 'Time pressure',
    className: 'hiring-pill hiring-pill-warning',
  },
  low_sample: { label: 'Low sample', className: 'hiring-pill' },
};

const WINDOW_OPTIONS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 3650, label: 'All time' },
] as const;

const QUEUE_FILTERS: readonly { key: 'all' | NudgeKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unreviewed_submission_48h', label: 'Unreviewed >48h' },
  { key: 'no_assessment_48h', label: 'No Assessment >48h' },
  { key: 'plan_gate_no_upgrade', label: 'Plan Gate Hits' },
  { key: 'problem_health_alert', label: 'Problem Alerts' },
];

const NUDGE_STATUS_BADGE: Readonly<
  Record<
    LifecycleActionQueueItem['nudgeStatus'],
    { label: string; className: string }
  >
> = {
  active: {
    label: 'Needs action',
    className: 'hiring-pill hiring-pill-warning',
  },
  contacted: {
    label: 'Contacted',
    className: 'hiring-pill hiring-pill-success',
  },
  snoozed: { label: 'Snoozed 7d', className: 'hiring-pill' },
  resolved: { label: 'Resolved', className: 'hiring-pill hiring-pill-success' },
  dismissed: { label: 'Dismissed', className: 'hiring-pill' },
};

function buildOutreachTemplate(item: LifecycleActionQueueItem): string {
  switch (item.nudgeKey) {
    case 'unreviewed_submission_48h':
      return `Hi ${item.organizationName} team — ${item.affectedCount} candidate submission(s) in your Hirearchy workspace have been waiting over ${Math.round(item.hoursAge)}h for an evaluator verdict. Sharing timely human feedback keeps candidate fairness high; happy to help unblock your review queue if needed.`;
    case 'no_assessment_48h':
      return `Hi ${item.organizationName} team — noticed you set up your Hirearchy workspace about ${Math.round(item.hoursAge)}h ago. If you'd like a quick walkthrough of our pre-built backend templates or candidate preview mode, reply here and I can help you launch your first evaluation in 5 minutes.`;
    case 'plan_gate_no_upgrade':
      return `Hi ${item.organizationName} team — saw your team recently hit a candidate slot / plan limit in Hirearchy. Happy to help calibrate whether Per Candidate slots, Pro, or Ultra fits your upcoming hiring loop.`;
    case 'problem_health_alert':
      return `Hi ${item.organizationName} team — our diagnostics flagged drop-off or sandbox errors on one of your active assessments. Let me know if you want a hand tuning the starter repo or time budget.`;
    case 'connect_slack_webhook':
      return `Hi ${item.organizationName} team — you can now connect a Slack incoming webhook in Workspace Settings to get instant alerts whenever candidates submit work.`;
  }
}

function retentionCellStyle(
  pct: number | null,
): React.CSSProperties | undefined {
  if (pct === null) return undefined;
  const alpha = Math.min(0.32, Math.max(0.04, (pct / 100) * 0.32));
  return {
    backgroundColor: `rgba(15, 118, 110, ${alpha.toFixed(2)})`,
    fontVariantNumeric: 'tabular-nums',
  };
}

type IntelSectionTab = 'overview' | 'queue' | 'health' | 'cohorts';

const SECTION_JUMP_TABS: readonly {
  id: IntelSectionTab;
  targetId: string;
  label: string;
}[] = [
  { id: 'overview', targetId: 'intel-overview', label: 'Overview & Funnel' },
  { id: 'queue', targetId: 'intel-action-queue', label: 'Action Queue' },
  { id: 'health', targetId: 'intel-health', label: 'Assessment Health' },
  { id: 'cohorts', targetId: 'intel-cohorts', label: 'Cohorts & Feedback' },
];

export function IntelligenceDashboardClient({
  initialReport,
  initialLifecycle = null,
}: Readonly<{
  initialReport: ProductIntelligenceReport | null;
  initialLifecycle?: ProductLifecycleReport | null;
}>) {
  const [report, setReport] = useState<ProductIntelligenceReport | null>(
    initialReport,
  );
  const [lifecycle, setLifecycle] = useState<ProductLifecycleReport | null>(
    initialLifecycle,
  );
  const [activeSection, setActiveSection] =
    useState<IntelSectionTab>('overview');
  const [queueFilter, setQueueFilter] = useState<'all' | NudgeKey>('all');
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [actionBusyKey, setActionBusyKey] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState<number>(
    initialReport?.windowDays ?? 30,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedbackFilter, setFeedbackFilter] = useState<
    'all' | 'candidate' | 'team_member'
  >('all');

  const itemRowKey = (item: LifecycleActionQueueItem) =>
    `${item.organizationId}:${item.nudgeKey}:${item.targetRef}`;

  const jumpToSection = (sectionId: IntelSectionTab) => {
    setActiveSection(sectionId);
    const tab = SECTION_JUMP_TABS.find((t) => t.id === sectionId);
    if (!tab || typeof document === 'undefined') return;
    document
      .getElementById(tab.targetId)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const applyQueueAction = async (
    item: LifecycleActionQueueItem,
    status: 'contacted' | 'snoozed' | 'resolved',
  ) => {
    const key = itemRowKey(item);
    const note = (noteDrafts[key] ?? item.founderNote ?? '').trim();
    setActionBusyKey(key);
    setError(null);
    try {
      const response = await fetch('/api/intelligence/action', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify({
          organizationId: item.organizationId,
          nudgeKey: item.nudgeKey,
          targetRef: item.targetRef,
          status,
          founderNote: note,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      setLifecycle((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          actionQueue: prev.actionQueue.map((row) =>
            itemRowKey(row) === key
              ? {
                  ...row,
                  nudgeStatus: status,
                  founderNote: note || row.founderNote,
                  contactedAt:
                    status === 'contacted'
                      ? new Date().toISOString()
                      : row.contactedAt,
                }
              : row,
          ),
        };
      });
      emitToast({
        message: `${item.organizationName} marked as ${status}.`,
        tone: 'success',
      });
    } catch {
      const msg = 'Unable to update outreach status right now.';
      setError(msg);
      emitToast({ message: msg, tone: 'error' });
    } finally {
      setActionBusyKey(null);
    }
  };

  const refreshWindow = async (days: number) => {
    setWindowDays(days);
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/intelligence?days=${days}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as {
        report?: ProductIntelligenceReport;
      };
      if (data.report) setReport(data.report);
    } catch {
      const msg = 'Unable to refresh intelligence metrics right now.';
      setError(msg);
      emitToast({ message: msg, tone: 'error' });
    } finally {
      setLoading(false);
    }
  };

  if (!report) {
    return (
      <section className="hiring-card">
        <h1>Product &amp; Hiring Intelligence</h1>
        <p className="hiring-muted-copy">
          Intelligence metrics will populate once PostgreSQL telemetry storage
          is connected.
        </p>
      </section>
    );
  }

  const funnelSteps = [
    { label: 'Orgs created', count: report.hiringFunnel.orgsCreated },
    {
      label: 'Problems saved',
      count: report.hiringFunnel.assessmentsAuthored,
    },
    { label: 'Invites issued', count: report.hiringFunnel.invitesIssued },
    {
      label: 'Candidates opened',
      count: report.hiringFunnel.candidatesOpened,
    },
    {
      label: 'Candidates started',
      count: report.hiringFunnel.candidatesStarted,
    },
    {
      label: 'Ran code / checks',
      count: report.hiringFunnel.candidatesRanCode,
    },
    { label: 'Submitted work', count: report.hiringFunnel.candidatesSubmitted },
    {
      label: 'Decisions published',
      count: report.hiringFunnel.decisionsPublished,
    },
    {
      label: 'Handoffs completed',
      count: report.hiringFunnel.handoffsCompleted,
    },
  ];
  const funnelPeak = Math.max(1, ...funnelSteps.map((s) => s.count));

  const filteredFeedback = report.recentFeedback.filter((item) =>
    feedbackFilter === 'all' ? true : item.actorType === feedbackFilter,
  );

  const actionQueueItems = (lifecycle?.actionQueue ?? []).filter((item) =>
    queueFilter === 'all' ? true : item.nudgeKey === queueFilter,
  );
  const cohortRows = lifecycle?.cohortRetention ?? [];

  return (
    <div className="intel-stack">
      <header className="intel-header">
        <div>
          <p className="software-eyebrow">Operator intelligence</p>
          <h1>Product, Marketing &amp; Hiring Health</h1>
          <p className="hiring-muted-copy">
            Live end-to-end diagnostics across workspaces, hiring pipelines, AI
            quality, acquisition channels, and candidate experience.
          </p>
        </div>
        <div className="intel-controls">
          <div
            className="hiring-builder-tabs"
            role="group"
            aria-label="Reporting window"
          >
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                type="button"
                className={`hiring-builder-tab${windowDays === opt.days ? ' is-active' : ''}`}
                aria-pressed={windowDays === opt.days}
                disabled={loading}
                onClick={() => void refreshWindow(opt.days)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="hiring-header-actions">
            <button
              type="button"
              className="hiring-btn hiring-btn-sm"
              disabled={loading}
              onClick={() => void refreshWindow(windowDays)}
            >
              <IconRefresh size={14} aria-hidden="true" />{' '}
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
            <a
              className="hiring-btn hiring-btn-sm"
              href={`/api/intelligence?days=${windowDays}&format=json`}
              download={`hirearchy-intelligence-${windowDays}d.json`}
            >
              <IconDownload size={14} aria-hidden="true" /> Export JSON
            </a>
            <a
              className="hiring-btn hiring-btn-primary hiring-btn-sm"
              href={`/api/intelligence?days=${windowDays}&format=csv`}
            >
              <IconDownload size={14} aria-hidden="true" /> Export CSV
            </a>
          </div>
        </div>
      </header>

      {error ? (
        <p className="hiring-banner hiring-banner-warning" role="alert">
          {error}
        </p>
      ) : null}

      <nav className="intel-jump-nav" aria-label="Intelligence sections">
        <HorizontalTabs<IntelSectionTab>
          id="intel-sections"
          label="Dashboard sections"
          active={activeSection}
          onSelect={jumpToSection}
          className="hiring-builder-tabs"
          tabClassName="hiring-builder-tab"
          tabs={SECTION_JUMP_TABS.map((t) => ({ id: t.id, label: t.label }))}
        />
      </nav>

      <section
        id="intel-overview"
        aria-labelledby="intel-proof-title"
        className="intel-section"
      >
        <div className="intel-section-head">
          <IconTrendingUp size={18} aria-hidden="true" />
          <h2 id="intel-proof-title">Executive Overview</h2>
        </div>
        <div className="intel-kpi-grid intel-kpi-grid--executive">
          <article className="hiring-card intel-kpi-card">
            <span className="intel-kpi-label">Active / Total Orgs</span>
            <strong className="intel-kpi-value tabular-nums">
              {report.marketingProof.activeOrganizations} /{' '}
              {report.marketingProof.totalOrganizations}
            </strong>
            <span className="intel-kpi-sub tabular-nums">
              Issued {report.marketingProof.totalSessionsIssued} assessments
            </span>
          </article>
          <article className="hiring-card intel-kpi-card">
            <span className="intel-kpi-label">Candidate Completion</span>
            <strong className="intel-kpi-value tabular-nums">
              {report.marketingProof.candidateCompletionRatePct}%
            </strong>
            <span className="intel-kpi-sub tabular-nums">
              {report.marketingProof.sessionsSubmitted} submitted of{' '}
              {report.marketingProof.sessionsStarted} started (
              {report.marketingProof.candidateStartRatePct}% start)
            </span>
          </article>
          <article className="hiring-card intel-kpi-card">
            <span className="intel-kpi-label">Median Review Turnaround</span>
            <strong className="intel-kpi-value tabular-nums">
              {report.marketingProof.medianReviewTurnaroundHours !== null
                ? `${report.marketingProof.medianReviewTurnaroundHours} hrs`
                : '—'}
            </strong>
            <span className="intel-kpi-sub tabular-nums">
              {report.marketingProof.decisionsPublished} decisions (
              {report.marketingProof.acceptanceRatePct}% accepted)
            </span>
          </article>
          <article className="hiring-card intel-kpi-card">
            <span className="intel-kpi-label">Candidate Fairness Score</span>
            <strong className="intel-kpi-value tabular-nums">
              {report.marketingProof.candidateSatisfactionAvg !== null
                ? `${report.marketingProof.candidateSatisfactionAvg} / 5`
                : '—'}
            </strong>
            <span className="intel-kpi-sub tabular-nums">
              {report.marketingProof.candidateFairnessPositivePct}% rated 4–5 ★
              ({report.marketingProof.totalCandidateFeedback} responses)
            </span>
          </article>
        </div>
      </section>

      <div className="intel-two-col">
        <section
          aria-labelledby="intel-funnel-title"
          className="hiring-card intel-section"
        >
          <div className="intel-section-head">
            <IconChartBar size={18} aria-hidden="true" />
            <h2 id="intel-funnel-title">End-to-End Hiring Funnel</h2>
          </div>
          <div className="intel-funnel-list">
            {funnelSteps.map((step) => {
              const pct = Math.round((step.count / funnelPeak) * 100);
              return (
                <div key={step.label} className="intel-funnel-row">
                  <span className="intel-funnel-label">{step.label}</span>
                  <progress
                    className="hiring-rubric-progress"
                    value={pct}
                    max={100}
                    aria-label={`${step.label}: ${step.count}`}
                  />
                  <strong className="intel-funnel-count tabular-nums">
                    {step.count}
                  </strong>
                </div>
              );
            })}
          </div>
        </section>

        <section
          aria-labelledby="intel-ai-monetization-title"
          className="hiring-card intel-section"
        >
          <div className="intel-section-head">
            <IconSparkles size={18} aria-hidden="true" />
            <h2 id="intel-ai-monetization-title">
              AI Builder &amp; Commercial Health
            </h2>
          </div>
          <div className="intel-stat-pairs">
            <div>
              <span>Median Candidate Time &amp; AI Adoption</span>
              <strong className="tabular-nums">
                {report.marketingProof.medianCandidateMinutes !== null
                  ? `${report.marketingProof.medianCandidateMinutes} min`
                  : '—'}{' '}
                · AI on {report.marketingProof.aiAssistantEnabledPct}% of
                sessions
              </strong>
            </div>
            <div>
              <span>AI Generations (Done / Failed)</span>
              <strong className="tabular-nums">
                {report.aiPerformance.generateCompleted} /{' '}
                {report.aiPerformance.generateFailed} (
                {report.aiPerformance.successRatePct}% ok)
              </strong>
            </div>
            <div>
              <span>AI Generation Latency (p50 / p95)</span>
              <strong className="tabular-nums">
                {report.aiPerformance.medianLatencyMs ?? '—'} ms /{' '}
                {report.aiPerformance.p95LatencyMs ?? '—'} ms
              </strong>
            </div>
            <div>
              <span>AI Problems Saved → Issued</span>
              <strong className="tabular-nums">
                {report.aiPerformance.problemsSaved} saved →{' '}
                {report.aiPerformance.aiProblemsIssued} issued
              </strong>
            </div>
            <div>
              <span>AI Builder Rating / Fit Review Opens</span>
              <strong className="tabular-nums">
                {report.aiPerformance.avgAiQualityRating !== null
                  ? `${report.aiPerformance.avgAiQualityRating} / 5 (${report.aiPerformance.aiFeedbackCount})`
                  : '—'}{' '}
                · {report.aiPerformance.advisoryReviewOpened} opens
              </strong>
            </div>
            <div>
              <span>Plan Funnel (Gates → Visits → Upgrades)</span>
              <strong className="tabular-nums">
                {report.monetization.planGateHits} gates →{' '}
                {report.monetization.upgradePageVisits} views →{' '}
                {report.monetization.planUpgrades} upgrades (+
                {report.monetization.slotAddons} slot packs)
              </strong>
            </div>
            <div>
              <span>Active Plan Distribution</span>
              <strong className="tabular-nums">
                None: {report.monetization.planDistribution.none} · Slots:{' '}
                {report.monetization.planDistribution.per_candidate} · Pro:{' '}
                {report.monetization.planDistribution.pro} · Ultra:{' '}
                {report.monetization.planDistribution.ultra}
              </strong>
            </div>
            <div>
              <span>Theme Split &amp; Client Errors</span>
              <strong className="tabular-nums">
                Light {report.uxFriction.themeSplit.light} / Dark{' '}
                {report.uxFriction.themeSplit.dark} ·{' '}
                {report.uxFriction.clientErrorCount} client errors
              </strong>
            </div>
          </div>
        </section>
      </div>

      <section
        id="intel-action-queue"
        aria-labelledby="intel-action-queue-title"
        className="hiring-card intel-section"
      >
        <div className="team-section-header-row">
          <div className="intel-section-head">
            <IconBolt size={18} aria-hidden="true" />
            <h2 id="intel-action-queue-title">
              Lifecycle Action Queue ({actionQueueItems.length})
            </h2>
          </div>
          <div
            className="hiring-builder-tabs"
            role="group"
            aria-label="Filter action queue"
          >
            {QUEUE_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`hiring-builder-tab${queueFilter === f.key ? ' is-active' : ''}`}
                aria-pressed={queueFilter === f.key}
                onClick={() => setQueueFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        {actionQueueItems.length === 0 ? (
          <p className="hiring-muted-copy">
            No organizations currently match this action filter.
          </p>
        ) : (
          <div className="software-overflow-region" tabIndex={0}>
            <table className="software-members-table intel-table">
              <thead>
                <tr>
                  <th>Organization</th>
                  <th>Plan</th>
                  <th>Trigger</th>
                  <th>Age</th>
                  <th>Count</th>
                  <th>Status</th>
                  <th>Note &amp; Outreach</th>
                </tr>
              </thead>
              <tbody>
                {actionQueueItems.map((item) => {
                  const key = itemRowKey(item);
                  const badge = NUDGE_STATUS_BADGE[item.nudgeStatus];
                  const isBusy = actionBusyKey === key;
                  return (
                    <tr key={key}>
                      <td>
                        <strong>{item.organizationName}</strong>
                        <div className="hiring-muted-copy">
                          {item.ownerEmail || item.organizationId.slice(0, 8)}
                        </div>
                      </td>
                      <td>
                        <span className="hiring-pill">{item.planTier}</span>
                      </td>
                      <td>{item.summary}</td>
                      <td className="tabular-nums">{item.hoursAge}h</td>
                      <td className="tabular-nums">{item.affectedCount}</td>
                      <td>
                        <span className={badge.className}>{badge.label}</span>
                      </td>
                      <td>
                        <div className="hiring-header-actions intel-table-actions">
                          <input
                            type="text"
                            className="intel-note-input"
                            aria-label={`Outreach note for ${item.organizationName}`}
                            placeholder="Outreach note…"
                            value={noteDrafts[key] ?? item.founderNote}
                            onChange={(e) =>
                              setNoteDrafts((prev) => ({
                                ...prev,
                                [key]: e.target.value,
                              }))
                            }
                          />
                          <CopyActionButton
                            value={buildOutreachTemplate(item)}
                            label="Copy outreach"
                            copiedLabel="Copied"
                            toastMessage={`Outreach template copied for ${item.organizationName}.`}
                            size="sm"
                            variant="secondary"
                          />
                          <button
                            type="button"
                            className="hiring-btn hiring-btn-primary hiring-btn-sm"
                            disabled={isBusy}
                            onClick={() =>
                              void applyQueueAction(item, 'contacted')
                            }
                          >
                            Mark contacted
                          </button>
                          <button
                            type="button"
                            className="hiring-btn hiring-btn-sm"
                            disabled={isBusy}
                            onClick={() =>
                              void applyQueueAction(item, 'snoozed')
                            }
                          >
                            <IconClock size={14} aria-hidden="true" /> Snooze 7d
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section
        id="intel-health"
        aria-labelledby="intel-health-title"
        className="hiring-card intel-section"
      >
        <div className="intel-section-head">
          <IconActivityHeartbeat size={18} aria-hidden="true" />
          <h2 id="intel-health-title">
            Assessment Calibration &amp; Failure Diagnostics
          </h2>
        </div>
        {report.assessmentHealth.length === 0 ? (
          <p className="hiring-muted-copy">
            No assessments issued within the selected window yet.
          </p>
        ) : (
          <div className="software-overflow-region" tabIndex={0}>
            <table className="software-members-table intel-table">
              <thead>
                <tr>
                  <th>Assessment</th>
                  <th>Role / Source</th>
                  <th>Issued</th>
                  <th>Started</th>
                  <th>Submitted</th>
                  <th>Completion</th>
                  <th>Median Time</th>
                  <th>Runner Errors</th>
                  <th>Candidate Rating</th>
                  <th>Health</th>
                </tr>
              </thead>
              <tbody>
                {report.assessmentHealth.map((row) => {
                  const badge = HEALTH_BADGE_MAP[row.healthFlag];
                  return (
                    <tr key={`${row.title}:${row.targetRole}`}>
                      <td>
                        <strong>{row.title}</strong>
                      </td>
                      <td>
                        {row.targetRole} · {row.sourceKind}
                      </td>
                      <td>{row.issued}</td>
                      <td>{row.started}</td>
                      <td>{row.submitted}</td>
                      <td>{row.completionRatePct}%</td>
                      <td>
                        {row.medianMinutes !== null
                          ? `${row.medianMinutes} min`
                          : '—'}
                      </td>
                      <td>{row.executionErrorRatePct}%</td>
                      <td>
                        {row.avgCandidateRating !== null
                          ? `${row.avgCandidateRating} / 5`
                          : '—'}
                      </td>
                      <td>
                        <span className={badge.className}>{badge.label}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="intel-two-col">
        <section
          aria-labelledby="intel-channels-title"
          className="hiring-card intel-section"
        >
          <h2 id="intel-channels-title">
            Marketing &amp; Acquisition Channels
          </h2>
          {report.acquisitionChannels.length === 0 ? (
            <p className="hiring-muted-copy">
              No visitor attribution recorded in this window yet.
            </p>
          ) : (
            <div className="software-overflow-region" tabIndex={0}>
              <table className="software-members-table intel-table">
                <thead>
                  <tr>
                    <th>Source / Medium</th>
                    <th>Campaign</th>
                    <th>Visitors</th>
                    <th>Signups</th>
                    <th>Orgs</th>
                    <th>Conv.</th>
                  </tr>
                </thead>
                <tbody>
                  {report.acquisitionChannels.map((ch) => (
                    <tr key={`${ch.source}:${ch.medium}:${ch.campaign}`}>
                      <td>
                        {ch.source} / {ch.medium}
                      </td>
                      <td>{ch.campaign}</td>
                      <td>{ch.visitors}</td>
                      <td>{ch.signups}</td>
                      <td>{ch.orgsCreated}</td>
                      <td>{ch.conversionRatePct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section
          aria-labelledby="intel-routes-title"
          className="hiring-card intel-section"
        >
          <h2 id="intel-routes-title">Top Routes &amp; Error Hotspots</h2>
          <div className="intel-stat-pairs">
            <div>
              <span>Top Visited Routes</span>
              <strong>
                {report.uxFriction.topRoutes.length > 0
                  ? report.uxFriction.topRoutes
                      .slice(0, 5)
                      .map((r) => `${r.route} (${r.views})`)
                      .join(' · ')
                  : 'No page views recorded yet'}
              </strong>
            </div>
            <div>
              <span>Top Recorded Error Events</span>
              <strong>
                {report.uxFriction.topErrors.length > 0
                  ? report.uxFriction.topErrors
                      .slice(0, 5)
                      .map((e) => `${e.eventName}@${e.route} (${e.count})`)
                      .join(' · ')
                  : 'Zero recorded error events'}
              </strong>
            </div>
          </div>
        </section>
      </div>

      <section
        id="intel-cohorts"
        aria-labelledby="intel-cohorts-title"
        className="hiring-card intel-section"
      >
        <div className="intel-section-head">
          <IconRepeat size={18} aria-hidden="true" />
          <h2 id="intel-cohorts-title">Repeat-Cycle Cohort Retention</h2>
        </div>
        {cohortRows.length === 0 ? (
          <p className="hiring-muted-copy">
            No monthly workspace cohorts recorded yet.
          </p>
        ) : (
          <div className="software-overflow-region" tabIndex={0}>
            <table className="software-members-table intel-table">
              <thead>
                <tr>
                  <th>Cohort</th>
                  <th>Orgs</th>
                  <th>7d Activated</th>
                  <th>M+1</th>
                  <th>M+2</th>
                  <th>M+3</th>
                  <th>Repeat-Wave %</th>
                  <th>Median Time-to-1st-Invite</th>
                </tr>
              </thead>
              <tbody>
                {cohortRows.map((row) => (
                  <tr key={row.cohortMonth}>
                    <td>
                      <strong>{row.cohortMonth}</strong>
                    </td>
                    <td>{row.orgsCreated}</td>
                    <td style={retentionCellStyle(row.activated7dPct)}>
                      {row.activated7dPct}%
                    </td>
                    <td style={retentionCellStyle(row.retainedM1Pct)}>
                      {row.retainedM1Pct !== null
                        ? `${row.retainedM1Pct}%`
                        : '—'}
                    </td>
                    <td style={retentionCellStyle(row.retainedM2Pct)}>
                      {row.retainedM2Pct !== null
                        ? `${row.retainedM2Pct}%`
                        : '—'}
                    </td>
                    <td style={retentionCellStyle(row.retainedM3Pct)}>
                      {row.retainedM3Pct !== null
                        ? `${row.retainedM3Pct}%`
                        : '—'}
                    </td>
                    <td>
                      {row.repeatWavePct}% ({row.repeatWaveOrgsCount})
                    </td>
                    <td>
                      {row.medianHoursToFirstInvite !== null
                        ? `${row.medianHoursToFirstInvite}h`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section
        aria-labelledby="intel-feedback-title"
        className="hiring-card intel-section"
      >
        <div className="team-section-header-row">
          <div className="intel-section-head">
            <IconMessageStar size={18} aria-hidden="true" />
            <h2 id="intel-feedback-title">
              Candidate &amp; Team Feedback Feed
            </h2>
          </div>
          <div
            className="hiring-builder-tabs"
            role="group"
            aria-label="Filter feedback by actor"
          >
            {(
              [
                ['all', 'All'],
                ['candidate', 'Candidates'],
                ['team_member', 'Teams'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`hiring-builder-tab${feedbackFilter === key ? ' is-active' : ''}`}
                aria-pressed={feedbackFilter === key}
                onClick={() => setFeedbackFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {filteredFeedback.length === 0 ? (
          <p className="hiring-muted-copy">
            No structured feedback submitted yet.
          </p>
        ) : (
          <ul className="intel-feedback-list">
            {filteredFeedback.map((fb) => (
              <li key={fb.id} className="intel-feedback-item">
                <div className="intel-feedback-meta">
                  <span
                    className={`hiring-pill ${fb.rating >= 4 ? 'hiring-pill-success' : fb.rating <= 2 ? 'hiring-pill-danger' : 'hiring-pill-warning'}`}
                  >
                    {fb.rating} / 5 ★
                  </span>
                  <span className="hiring-pill hiring-pill-plum">
                    {fb.actorType === 'candidate' ? 'Candidate' : 'Team'}
                  </span>
                  <span className="hiring-muted-copy">{fb.surface}</span>
                </div>
                {fb.tags.length > 0 ? (
                  <div className="hiring-chip-group">
                    {fb.tags.map((tag) => (
                      <span key={tag} className="hiring-pill">
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
                {fb.comment ? <p>{fb.comment}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
