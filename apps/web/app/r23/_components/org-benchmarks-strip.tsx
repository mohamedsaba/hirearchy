'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { IconActivityHeartbeat, IconAlertTriangle } from '@tabler/icons-react';

export type ProblemHealthFlag =
  'low_sample' | 'runner_errors' | 'high_dropoff' | 'time_pressure' | 'healthy';

export interface OrgProblemHealthItem {
  readonly definitionId: string;
  readonly title: string;
  readonly sourceKind: string;
  readonly targetRole: string;
  readonly experienceLevel: string;
  readonly durationMinutes: number;
  readonly issued: number;
  readonly started: number;
  readonly submitted: number;
  readonly completionRatePct: number;
  readonly medianMinutes: number | null;
  readonly executionErrorRatePct: number;
  readonly avgCandidateRating: number | null;
  readonly healthFlag: ProblemHealthFlag;
  readonly diagnosticHint: string;
}

export interface OrgRoleBenchmarkItem {
  readonly targetRole: string;
  readonly experienceLevel: string;
  readonly benchmarkScope: 'role_level' | 'role';
  readonly orgCompletionRatePct: number | null;
  readonly orgMedianMinutes: number | null;
  readonly platformMedianCompletionRatePct: number | null;
  readonly platformMedianMinutes: number | null;
  readonly platformAcceptanceRatePct: number | null;
  readonly sampleSessions: number;
}

export interface OrgHiringHealthResponse {
  readonly problems: readonly OrgProblemHealthItem[];
  readonly benchmarks: readonly OrgRoleBenchmarkItem[];
}

export function healthFlagMeta(flag: ProblemHealthFlag): Readonly<{
  label: string;
  pillClass: string;
  isAlert: boolean;
}> {
  switch (flag) {
    case 'healthy':
      return {
        label: 'Healthy',
        pillClass: 'hiring-pill hiring-pill-success',
        isAlert: false,
      };
    case 'runner_errors':
      return {
        label: 'Runner errors',
        pillClass: 'hiring-pill hiring-pill-danger',
        isAlert: true,
      };
    case 'high_dropoff':
      return {
        label: 'High drop-off',
        pillClass: 'hiring-pill hiring-pill-warning',
        isAlert: true,
      };
    case 'time_pressure':
      return {
        label: 'Time pressure',
        pillClass: 'hiring-pill hiring-pill-warning',
        isAlert: true,
      };
    default:
      return {
        label: 'Low sample',
        pillClass: 'hiring-pill',
        isAlert: false,
      };
  }
}

export function OrgBenchmarksStrip({
  organizationId,
  compact = false,
  showProblemHealth = false,
  initialData = null,
}: {
  readonly organizationId: string;
  readonly compact?: boolean;
  readonly showProblemHealth?: boolean;
  readonly initialData?: OrgHiringHealthResponse | null;
}) {
  const [fetchedData, setFetchedData] =
    useState<OrgHiringHealthResponse | null>(null);

  useEffect(() => {
    if (initialData || typeof fetch !== 'function') return;
    let active = true;
    fetch(
      `/r23/api/organizations/${encodeURIComponent(organizationId)}/hiring/health`,
      { headers: { Accept: 'application/json' }, cache: 'no-store' },
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((payload: OrgHiringHealthResponse | null) => {
        if (
          active &&
          payload &&
          Array.isArray(payload.problems) &&
          Array.isArray(payload.benchmarks)
        ) {
          setFetchedData(payload);
        }
      })
      .catch(() => {
        // Non-blocking enrichment when health endpoint is unavailable.
      });
    return () => {
      active = false;
    };
  }, [organizationId, initialData]);

  const data = initialData ?? fetchedData;
  if (!data) {
    return null;
  }

  const { problems, benchmarks } = data;
  const flaggedProblems = problems.filter(
    (p) => healthFlagMeta(p.healthFlag).isAlert,
  );

  if (compact && problems.length === 0 && benchmarks.length === 0) {
    return null;
  }

  const orgBase = `/r23/organizations/${encodeURIComponent(organizationId)}`;
  const totalStarted = problems.reduce((acc, p) => acc + p.started, 0);
  const totalSubmitted = problems.reduce((acc, p) => acc + p.submitted, 0);
  const overallCompletion =
    totalStarted > 0 ? Math.round((totalSubmitted / totalStarted) * 100) : null;

  return (
    <section
      className={`hiring-card org-benchmarks-strip${compact ? ' is-compact' : ''}`}
      aria-label="Assessment health and role benchmarks"
      data-testid="org-benchmarks-strip"
    >
      <div className="org-benchmarks-header">
        <div className="org-benchmarks-title">
          <IconActivityHeartbeat size={17} aria-hidden="true" />
          <div>
            <h2>Role benchmarks &amp; problem health</h2>
            {!compact ? (
              <p className="hiring-muted-copy">
                Compare completion and pacing against k-anonymous platform role
                medians.
              </p>
            ) : null}
          </div>
        </div>
        <div className="org-benchmarks-summary-pills">
          {overallCompletion !== null ? (
            <span className="hiring-pill hiring-pill-plum">
              Org completion {overallCompletion}%
            </span>
          ) : null}
          {flaggedProblems.length > 0 ? (
            <Link
              href={`${orgBase}/builder?mode=library`}
              className="hiring-pill hiring-pill-warning"
            >
              <IconAlertTriangle size={13} aria-hidden="true" />{' '}
              {flaggedProblems.length}{' '}
              {flaggedProblems.length === 1
                ? 'problem alert'
                : 'problem alerts'}
            </Link>
          ) : problems.length > 0 ? (
            <span className="hiring-pill hiring-pill-success">
              All problems healthy
            </span>
          ) : null}
        </div>
      </div>

      {benchmarks.length > 0 ? (
        <div className="org-benchmark-grid">
          {benchmarks.slice(0, compact ? 2 : 6).map((b) => {
            const hasPlatform =
              b.platformMedianCompletionRatePct !== null ||
              b.platformMedianMinutes !== null;
            return (
              <article
                key={`${b.targetRole}:${b.experienceLevel}:${b.benchmarkScope}`}
                className="hiring-card-subtle org-benchmark-card"
              >
                <div className="org-benchmark-role">
                  <strong>{b.targetRole || 'Engineering'}</strong>
                  <span className="hiring-pill">
                    {b.benchmarkScope === 'role_level'
                      ? b.experienceLevel
                      : 'All levels'}
                  </span>
                </div>
                {hasPlatform ? (
                  <p className="org-benchmark-metrics">
                    <span>
                      Completion:{' '}
                      <strong>
                        {b.orgCompletionRatePct !== null
                          ? `${b.orgCompletionRatePct}%`
                          : '—'}
                      </strong>{' '}
                      vs{' '}
                      {b.platformMedianCompletionRatePct !== null
                        ? `${b.platformMedianCompletionRatePct}% platform median`
                        : 'pending'}
                    </span>
                    <span>
                      Median solve:{' '}
                      <strong>
                        {b.orgMedianMinutes !== null
                          ? `${b.orgMedianMinutes}m`
                          : '—'}
                      </strong>{' '}
                      vs{' '}
                      {b.platformMedianMinutes !== null
                        ? `${b.platformMedianMinutes}m platform median`
                        : 'pending'}
                    </span>
                  </p>
                ) : (
                  <p
                    className="hiring-muted-copy org-benchmark-pending"
                    data-testid="benchmark-pending-note"
                  >
                    Your org:{' '}
                    {b.orgCompletionRatePct !== null
                      ? `${b.orgCompletionRatePct}% completion`
                      : '—'}
                    {b.orgMedianMinutes !== null
                      ? ` · ${b.orgMedianMinutes}m median`
                      : ''}{' '}
                    — Platform benchmark unlocks with more platform volume.
                  </p>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <p
          className="hiring-muted-copy org-benchmark-pending"
          data-testid="benchmark-pending-note"
        >
          Platform role benchmarks unlock once enough organizations complete
          evaluations in your role.
        </p>
      )}

      {flaggedProblems.length > 0 ? (
        <div className="org-health-alerts" aria-label="Flagged problem alerts">
          {flaggedProblems.map((p) => {
            const meta = healthFlagMeta(p.healthFlag);
            return (
              <div key={p.definitionId} className="org-health-alert-row">
                <div>
                  <span className={meta.pillClass}>{meta.label}</span>{' '}
                  <strong>{p.title}</strong>
                  <span className="hiring-muted-copy">
                    {' '}
                    — {p.diagnosticHint}
                  </span>
                </div>
                <Link
                  className="hiring-btn hiring-btn-sm"
                  href={`${orgBase}/builder?mode=library`}
                >
                  Inspect problem
                </Link>
              </div>
            );
          })}
        </div>
      ) : null}

      {showProblemHealth && problems.length > 0 ? (
        <div className="org-problem-health-list">
          <h3>Problem diagnostics</h3>
          <div className="org-health-alerts">
            {problems.map((p) => {
              const meta = healthFlagMeta(p.healthFlag);
              return (
                <div
                  key={p.definitionId}
                  className="org-health-alert-row"
                  data-problem-id={p.definitionId}
                >
                  <div className="org-problem-health-meta">
                    <span className={meta.pillClass}>{meta.label}</span>
                    <strong>{p.title}</strong>
                    <span className="hiring-muted-copy">
                      {p.started} started · {p.completionRatePct}% completion
                      {p.medianMinutes !== null
                        ? ` · ${p.medianMinutes}m / ${p.durationMinutes}m`
                        : ''}
                      {p.executionErrorRatePct > 0
                        ? ` · ${p.executionErrorRatePct}% runner errors`
                        : ''}
                      {p.avgCandidateRating !== null
                        ? ` · ${p.avgCandidateRating.toFixed(1)}★`
                        : ''}
                    </span>
                    {p.diagnosticHint ? (
                      <p className="hiring-muted-copy">{p.diagnosticHint}</p>
                    ) : null}
                  </div>
                  <Link
                    className="hiring-btn hiring-btn-sm"
                    href={`${orgBase}/builder?mode=library`}
                  >
                    Customize in builder
                  </Link>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
