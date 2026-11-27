'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { IconEyeCheck } from '@tabler/icons-react';

import {
  HIRING_ROLES,
  NEXT_STAGE_OPTIONS,
  experienceLevelLabel,
} from '../../../../../src/hiring/catalogs';
import type { HandoffDossierItem } from '../../../../../src/hiring/types';
import {
  readPersistedJson,
  removePersistedKey,
  writePersistedJson,
} from '../../../../../src/ui/browser-state';
import {
  formatLocalDateTime,
  formatRelativeTime,
} from '../../../../../src/ui/relative-time';

export interface HandoffsHubClientProps {
  readonly organizationId: string;
  readonly initialHandoffs: readonly HandoffDossierItem[];
}

function handoffPillClass(status: string): string {
  switch (status) {
    case 'completed':
      return 'hiring-pill hiring-pill-success';
    case 'reviewed':
      return 'hiring-pill hiring-pill-plum';
    default:
      return 'hiring-pill hiring-pill-warning';
  }
}

function handoffStatusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return 'Needs review';
    case 'reviewed':
      return 'Reviewed';
    case 'completed':
      return 'Interview done';
    default:
      return status;
  }
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function HandoffsHubClient({
  organizationId,
  initialHandoffs,
}: HandoffsHubClientProps) {
  const [stageFilter, setStageFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [roleFilter, setRoleFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [filtersHydrated, setFiltersHydrated] = useState(false);
  const filterStorageKey = `hirearchy:org:handoffs-filters:v1:${organizationId}`;

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const params = new URLSearchParams(window.location.search);
      const hasUrlParams =
        params.has('q') ||
        params.has('status') ||
        params.has('stage') ||
        params.has('role');
      const saved = readPersistedJson<{
        searchQuery?: string;
        statusFilter?: string;
        stageFilter?: string;
        roleFilter?: string;
        moreFiltersOpen?: boolean;
      }>(filterStorageKey, 'session');
      if (hasUrlParams) {
        const q = params.get('q');
        const st = params.get('status');
        const stage = params.get('stage');
        const role = params.get('role');
        if (q) setSearchQuery(q);
        if (st && ['pending', 'reviewed', 'completed'].includes(st)) {
          setStatusFilter(st);
        }
        if (stage) setStageFilter(stage);
        if (role) setRoleFilter(role);
        if (typeof saved?.moreFiltersOpen === 'boolean') {
          setMoreFiltersOpen(saved.moreFiltersOpen);
        } else if (stage || role) {
          setMoreFiltersOpen(true);
        }
      } else {
        if (saved && typeof saved === 'object') {
          if (typeof saved.searchQuery === 'string') {
            setSearchQuery(saved.searchQuery);
          }
          if (
            saved.statusFilter &&
            ['pending', 'reviewed', 'completed'].includes(saved.statusFilter)
          ) {
            setStatusFilter(saved.statusFilter);
          }
          if (typeof saved.stageFilter === 'string') {
            setStageFilter(saved.stageFilter);
          }
          if (typeof saved.roleFilter === 'string') {
            setRoleFilter(saved.roleFilter);
          }
          if (typeof saved.moreFiltersOpen === 'boolean') {
            setMoreFiltersOpen(saved.moreFiltersOpen);
          } else if (
            (saved.stageFilter && saved.stageFilter !== 'all') ||
            (saved.roleFilter && saved.roleFilter !== 'all')
          ) {
            setMoreFiltersOpen(true);
          }
        }
      }
      setFiltersHydrated(true);
    });
    return () => {
      active = false;
    };
  }, [filterStorageKey]);

  useEffect(() => {
    if (!filtersHydrated) return;
    const url = new URL(window.location.href);
    if (searchQuery.trim()) url.searchParams.set('q', searchQuery.trim());
    else url.searchParams.delete('q');
    if (statusFilter !== 'all') url.searchParams.set('status', statusFilter);
    else url.searchParams.delete('status');
    if (stageFilter !== 'all') url.searchParams.set('stage', stageFilter);
    else url.searchParams.delete('stage');
    if (roleFilter !== 'all') url.searchParams.set('role', roleFilter);
    else url.searchParams.delete('role');
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}`,
    );

    const hasActiveFilters =
      searchQuery.trim().length > 0 ||
      statusFilter !== 'all' ||
      stageFilter !== 'all' ||
      roleFilter !== 'all' ||
      moreFiltersOpen;
    if (!hasActiveFilters) {
      removePersistedKey(filterStorageKey);
      return;
    }
    writePersistedJson(
      filterStorageKey,
      {
        searchQuery,
        statusFilter,
        stageFilter,
        roleFilter,
        moreFiltersOpen,
      },
      'session',
    );
  }, [
    filterStorageKey,
    filtersHydrated,
    moreFiltersOpen,
    roleFilter,
    searchQuery,
    stageFilter,
    statusFilter,
  ]);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const isFiltered =
    stageFilter !== 'all' ||
    statusFilter !== 'all' ||
    roleFilter !== 'all' ||
    normalizedQuery.length > 0;

  const filtered = useMemo(() => {
    return initialHandoffs.filter((item) => {
      if (
        stageFilter !== 'all' &&
        (item.decision.nextStageLabel ?? '') !== stageFilter
      ) {
        return false;
      }
      if (
        statusFilter !== 'all' &&
        item.decision.handoffStatus !== statusFilter
      ) {
        return false;
      }
      if (roleFilter !== 'all' && item.targetRole !== roleFilter) {
        return false;
      }
      if (
        normalizedQuery &&
        !item.candidateName.toLowerCase().includes(normalizedQuery) &&
        !item.candidateEmail.toLowerCase().includes(normalizedQuery) &&
        !item.targetRole.toLowerCase().includes(normalizedQuery) &&
        !item.scenarioTitle.toLowerCase().includes(normalizedQuery)
      ) {
        return false;
      }
      return true;
    });
  }, [initialHandoffs, stageFilter, statusFilter, roleFilter, normalizedQuery]);

  const clearFilters = () => {
    setStageFilter('all');
    setStatusFilter('all');
    setRoleFilter('all');
    setSearchQuery('');
    setMoreFiltersOpen(false);
    removePersistedKey(filterStorageKey);
  };

  const orgBase = `/r23/organizations/${encodeURIComponent(organizationId)}`;
  const needsReviewCount = useMemo(
    () =>
      initialHandoffs.filter((h) => h.decision.handoffStatus === 'pending')
        .length,
    [initialHandoffs],
  );
  const reviewedCount = useMemo(
    () =>
      initialHandoffs.filter((h) => h.decision.handoffStatus === 'reviewed')
        .length,
    [initialHandoffs],
  );
  const completedCount = useMemo(
    () =>
      initialHandoffs.filter((h) => h.decision.handoffStatus === 'completed')
        .length,
    [initialHandoffs],
  );

  return (
    <div className="hiring-page-shell">
      {initialHandoffs.length > 0 ? (
        <>
          <div
            className="team-pipeline-pulse-bar"
            role="region"
            aria-label="Handoff status summary"
          >
            <div
              className="team-pulse-pills"
              role="group"
              aria-label="Quick handoff filters"
            >
              <button
                type="button"
                className="hiring-btn hiring-btn-sm team-pulse-pill"
                aria-pressed={statusFilter === 'all'}
                onClick={() => setStatusFilter('all')}
              >
                All{' '}
                <span className="tabular-nums">({initialHandoffs.length})</span>
              </button>
              <button
                type="button"
                className="hiring-btn hiring-btn-sm team-pulse-pill team-review-filter"
                aria-pressed={statusFilter === 'pending'}
                onClick={() =>
                  setStatusFilter(
                    statusFilter === 'pending' ? 'all' : 'pending',
                  )
                }
              >
                <IconEyeCheck size={15} aria-hidden="true" />
                Needs review{' '}
                <span className="tabular-nums">({needsReviewCount})</span>
              </button>
              <button
                type="button"
                className="hiring-btn hiring-btn-sm team-pulse-pill"
                aria-pressed={statusFilter === 'reviewed'}
                onClick={() =>
                  setStatusFilter(
                    statusFilter === 'reviewed' ? 'all' : 'reviewed',
                  )
                }
              >
                Reviewed <span className="tabular-nums">({reviewedCount})</span>
              </button>
              <button
                type="button"
                className="hiring-btn hiring-btn-sm team-pulse-pill"
                aria-pressed={statusFilter === 'completed'}
                onClick={() =>
                  setStatusFilter(
                    statusFilter === 'completed' ? 'all' : 'completed',
                  )
                }
              >
                Interview done{' '}
                <span className="tabular-nums">({completedCount})</span>
              </button>
            </div>
          </div>

          <section className="hiring-filter-bar" aria-label="Filter handoffs">
            <div className="hiring-filter-primary">
              <div className="hiring-field">
                <label htmlFor="handoff-search">Search</label>
                <input
                  id="handoff-search"
                  type="search"
                  aria-label="Search handoffs"
                  placeholder="Find a handoff…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <div className="hiring-field">
                <label htmlFor="handoff-status">Handoff status</label>
                <select
                  id="handoff-status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="all">All statuses</option>
                  <option value="pending">Needs review</option>
                  <option value="reviewed">Reviewed</option>
                  <option value="completed">Interview done</option>
                </select>
              </div>
            </div>
            <details
              className="hiring-disclosure hiring-more-filters"
              open={moreFiltersOpen}
              onToggle={(event) => {
                setMoreFiltersOpen(event.currentTarget.open);
              }}
            >
              <summary>More filters</summary>
              <div className="hiring-filter-grid hiring-mt-xs">
                <div className="hiring-field">
                  <label htmlFor="handoff-stage">Next hiring stage</label>
                  <select
                    id="handoff-stage"
                    value={stageFilter}
                    onChange={(e) => setStageFilter(e.target.value)}
                  >
                    <option value="all">All stages</option>
                    {NEXT_STAGE_OPTIONS.map((stage) => (
                      <option key={stage} value={stage}>
                        {stage}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="hiring-field">
                  <label htmlFor="handoff-role">Target role</label>
                  <select
                    id="handoff-role"
                    value={roleFilter}
                    onChange={(e) => setRoleFilter(e.target.value)}
                  >
                    <option value="all">All roles</option>
                    {HIRING_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </details>
            {isFiltered ? (
              <div className="hiring-header-actions">
                <button
                  type="button"
                  className="hiring-btn hiring-btn-sm"
                  onClick={clearFilters}
                >
                  Clear filters
                </button>
              </div>
            ) : null}
          </section>
        </>
      ) : null}

      {filtered.length === 0 ? (
        <div className="hiring-card">
          <h2>
            {initialHandoffs.length === 0
              ? 'No interview handoffs yet'
              : 'No handoffs match these filters'}
          </h2>
          <p>
            {initialHandoffs.length === 0
              ? 'Advance a candidate and assign their next interview to create a handoff.'
              : 'Try a different search or clear your filters.'}
          </p>
        </div>
      ) : (
        <div className="hiring-candidate-list">
          {filtered.map((item) => (
            <article
              key={item.sessionId}
              className="hiring-candidate-card hiring-card-animated"
            >
              <div className="hiring-candidate-header">
                <div className="hiring-candidate-identity">
                  <span className="hiring-avatar" aria-hidden="true">
                    {getInitials(item.candidateName)}
                  </span>
                  <div>
                    <div className="hiring-candidate-name">
                      <h2>{item.candidateName}</h2>
                      <span
                        className={handoffPillClass(
                          item.decision.handoffStatus,
                        )}
                      >
                        {handoffStatusLabel(item.decision.handoffStatus)}
                      </span>
                      <span className="hiring-pill hiring-pill-plum">
                        {item.decision.nextStageLabel ?? 'Managerial Interview'}
                      </span>
                      {item.candidateCode ? (
                        <span className="hiring-pill">
                          {item.candidateCode}
                        </span>
                      ) : null}
                      {item.secondOpinions.length > 0
                        ? (() => {
                            const approved = item.secondOpinions.filter(
                              (op) =>
                                op.status === 'completed' &&
                                op.verdict === 'approve',
                            ).length;
                            const flagged = item.secondOpinions.filter(
                              (op) =>
                                op.status === 'completed' &&
                                op.verdict === 'request_changes',
                            ).length;
                            const pillCls =
                              flagged > 0
                                ? 'hiring-pill hiring-pill-danger'
                                : approved > 0
                                  ? 'hiring-pill hiring-pill-success'
                                  : 'hiring-pill';
                            const label =
                              flagged > 0
                                ? `${flagged} peer concern${flagged === 1 ? '' : 's'}`
                                : approved > 0
                                  ? `${approved} peer approved`
                                  : `${item.secondOpinions.length} peer review${item.secondOpinions.length === 1 ? '' : 's'}`;
                            return <span className={pillCls}>{label}</span>;
                          })()
                        : null}
                    </div>
                    <div className="hiring-candidate-meta">
                      <span>{item.candidateEmail}</span>
                      <span>
                        {item.targetRole} ·{' '}
                        {experienceLevelLabel(item.experienceLevel)}
                      </span>
                      <span>Assessment: {item.scenarioTitle}</span>
                      <span>Decided by: {item.decision.decidedByName}</span>
                      <span>
                        Manager:{' '}
                        {item.decision.handoffRecipientName ?? 'Team manager'}
                      </span>
                      <span
                        title={formatLocalDateTime(
                          item.decision.updatedAt ?? item.submittedAt,
                        )}
                      >
                        Updated{' '}
                        {formatRelativeTime(
                          item.decision.updatedAt ?? item.submittedAt,
                        )}
                      </span>
                    </div>
                    {item.decision.performanceReport ? (
                      <p className="hiring-fit-headline">
                        <strong>Fit Report:</strong>{' '}
                        {item.decision.performanceReport.fitHeadline}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="hiring-chip-group">
                  {item.skills.slice(0, 5).map((skill) => (
                    <span key={skill} className="hiring-pill">
                      {skill}
                    </span>
                  ))}
                </div>

                <div className="hiring-header-actions">
                  <Link
                    className="hiring-btn hiring-btn-primary hiring-btn-sm"
                    href={`${orgBase}/handoffs/${encodeURIComponent(item.sessionId)}`}
                  >
                    Open Handoff Dossier
                  </Link>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
