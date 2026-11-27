'use client';

import { useState } from 'react';
import {
  IconActivityHeartbeat,
  IconChartBar,
  IconDownload,
  IconMessageStar,
  IconRefresh,
  IconSparkles,
  IconTrendingUp,
} from '@tabler/icons-react';

import type { ProductIntelligenceReport } from '../../../src/telemetry/catalog';

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

export function IntelligenceDashboardClient({
  initialReport,
}: Readonly<{ initialReport: ProductIntelligenceReport | null }>) {
  const [report, setReport] = useState<ProductIntelligenceReport | null>(
    initialReport,
  );
  const [windowDays, setWindowDays] = useState<number>(
    initialReport?.windowDays ?? 30,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedbackFilter, setFeedbackFilter] = useState<
    'all' | 'candidate' | 'team_member'
  >('all');

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
      setError('Unable to refresh intelligence metrics right now.');
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

      <section aria-labelledby="intel-proof-title" className="intel-section">
        <div className="intel-section-head">
          <IconTrendingUp size={18} aria-hidden="true" />
          <h2 id="intel-proof-title">Marketing &amp; Product Proof</h2>
        </div>
        <div className="intel-kpi-grid">
          <article className="hiring-card intel-kpi-card">
            <span className="intel-kpi-label">Active / Total Orgs</span>
            <strong className="intel-kpi-value">
              {report.marketingProof.activeOrganizations} /{' '}
              {report.marketingProof.totalOrganizations}
            </strong>
            <span className="intel-kpi-sub">
              Issued {report.marketingProof.totalSessionsIssued} assessments
            </span>
          </article>
          <article className="hiring-card intel-kpi-card">
            <span className="intel-kpi-label">Candidate Completion</span>
            <strong className="intel-kpi-value">
              {report.marketingProof.candidateCompletionRatePct}%
            </strong>
            <span className="intel-kpi-sub">
              {report.marketingProof.sessionsSubmitted} submitted of{' '}
              {report.marketingProof.sessionsStarted} started (
              {report.marketingProof.candidateStartRatePct}% start rate)
            </span>
          </article>
          <article className="hiring-card intel-kpi-card">
            <span className="intel-kpi-label">Median Candidate Time</span>
            <strong className="intel-kpi-value">
              {report.marketingProof.medianCandidateMinutes !== null
                ? `${report.marketingProof.medianCandidateMinutes} min`
                : '—'}
            </strong>
            <span className="intel-kpi-sub">
              AI enabled on {report.marketingProof.aiAssistantEnabledPct}% of
              sessions
            </span>
          </article>
          <article className="hiring-card intel-kpi-card">
            <span className="intel-kpi-label">Median Review Turnaround</span>
            <strong className="intel-kpi-value">
              {report.marketingProof.medianReviewTurnaroundHours !== null
                ? `${report.marketingProof.medianReviewTurnaroundHours} hrs`
                : '—'}
            </strong>
            <span className="intel-kpi-sub">
              {report.marketingProof.decisionsPublished} decisions (
              {report.marketingProof.acceptanceRatePct}% accepted)
            </span>
          </article>
          <article className="hiring-card intel-kpi-card">
            <span className="intel-kpi-label">Candidate Fairness Score</span>
            <strong className="intel-kpi-value">
              {report.marketingProof.candidateSatisfactionAvg !== null
                ? `${report.marketingProof.candidateSatisfactionAvg} / 5`
                : '—'}
            </strong>
            <span className="intel-kpi-sub">
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
                  <strong className="intel-funnel-count">{step.count}</strong>
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
              <span>AI Generations (Done / Failed)</span>
              <strong>
                {report.aiPerformance.generateCompleted} /{' '}
                {report.aiPerformance.generateFailed} (
                {report.aiPerformance.successRatePct}% ok)
              </strong>
            </div>
            <div>
              <span>AI Generation Latency (p50 / p95)</span>
              <strong>
                {report.aiPerformance.medianLatencyMs ?? '—'} ms /{' '}
                {report.aiPerformance.p95LatencyMs ?? '—'} ms
              </strong>
            </div>
            <div>
              <span>AI Problems Saved → Issued</span>
              <strong>
                {report.aiPerformance.problemsSaved} saved →{' '}
                {report.aiPerformance.aiProblemsIssued} issued
              </strong>
            </div>
            <div>
              <span>AI Builder Rating / Fit Review Opens</span>
              <strong>
                {report.aiPerformance.avgAiQualityRating !== null
                  ? `${report.aiPerformance.avgAiQualityRating} / 5 (${report.aiPerformance.aiFeedbackCount})`
                  : '—'}{' '}
                · {report.aiPerformance.advisoryReviewOpened} opens
              </strong>
            </div>
            <div>
              <span>Plan Funnel (Gates → Visits → Upgrades)</span>
              <strong>
                {report.monetization.planGateHits} gates →{' '}
                {report.monetization.upgradePageVisits} views →{' '}
                {report.monetization.planUpgrades} upgrades (+
                {report.monetization.slotAddons} slot packs)
              </strong>
            </div>
            <div>
              <span>Active Plan Distribution</span>
              <strong>
                None: {report.monetization.planDistribution.none} · Slots:{' '}
                {report.monetization.planDistribution.per_candidate} · Pro:{' '}
                {report.monetization.planDistribution.pro} · Ultra:{' '}
                {report.monetization.planDistribution.ultra}
              </strong>
            </div>
            <div>
              <span>Theme Split &amp; Client Errors</span>
              <strong>
                Light {report.uxFriction.themeSplit.light} / Dark{' '}
                {report.uxFriction.themeSplit.dark} ·{' '}
                {report.uxFriction.clientErrorCount} client errors
              </strong>
            </div>
          </div>
        </section>
      </div>

      <section
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
