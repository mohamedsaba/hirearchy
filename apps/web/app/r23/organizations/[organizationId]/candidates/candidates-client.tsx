'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  IconChevronDown,
  IconEyeCheck,
  IconMapPin,
  IconSparkles,
  IconUserCheck,
  IconX,
} from '@tabler/icons-react';

import {
  filterAndSortCandidates,
  matchesCandidateSessionFilters,
} from '../../../../../src/hiring/candidates-view';
import {
  CANDIDATE_SORT_OPTIONS,
  EXPERIENCE_LEVELS,
  PIPELINE_STATUS_OPTIONS,
  experienceLevelLabel,
  type CandidateSortId,
  type PipelineStatusId,
} from '../../../../../src/hiring/catalogs';
import type {
  OrgCandidateRecord,
  OrgCandidateSessionItem,
  WorkspaceRoleKind,
} from '../../../../../src/hiring/types';
import { type OrganizationPlanSummary } from '../../../../../src/plans/entitlements';
import {
  readPersistedJson,
  removePersistedKey,
  writePersistedJson,
} from '../../../../../src/ui/browser-state';
import {
  formatLocalDateTime,
  formatRelativeTime,
} from '../../../../../src/ui/relative-time';
import { CopyActionButton } from '../../../../_components/copy-action-button';
import { OrgActivationChecklist } from '../../../_components/org-activation-checklist';
import { OrgBenchmarksStrip } from '../../../_components/org-benchmarks-strip';
import { OrgNudgeBanner } from '../../../_components/org-nudge-banner';

export interface CandidatesPipelineClientProps {
  readonly organizationId: string;
  readonly initialCandidates: readonly OrgCandidateRecord[];
  readonly plan: OrganizationPlanSummary;
  readonly currentRole: WorkspaceRoleKind;
  readonly currentPrincipalId?: string;
}

function statusPillClass(status: PipelineStatusId): string {
  switch (status) {
    case 'accepted':
      return 'hiring-pill hiring-pill-success';
    case 'rejected':
      return 'hiring-pill hiring-pill-danger';
    case 'second_opinion':
    case 'ready_for_review':
      return 'hiring-pill hiring-pill-plum';
    case 'in_progress':
      return 'hiring-pill hiring-pill-warning';
    default:
      return 'hiring-pill';
  }
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function statusLabel(status: PipelineStatusId): string {
  return (
    PIPELINE_STATUS_OPTIONS.find((item) => item.id === status)?.label ?? status
  );
}

function formatDateShort(iso: string | null): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return '—';
  return new Date(parsed).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function CandidatesPipelineClient({
  organizationId,
  initialCandidates: candidates,
  plan,
  currentRole,
  currentPrincipalId,
}: CandidatesPipelineClientProps) {
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<PipelineStatusId>('all');
  const [decidedOnly, setDecidedOnly] = useState(false);
  const [experienceFilter, setExperienceFilter] = useState('all');
  const [yearsFilter, setYearsFilter] = useState('all');
  const [locationFilter, setLocationFilter] = useState('all');
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<CandidateSortId>('recent');
  const [searchQuery, setSearchQuery] = useState('');
  const [filtersHydrated, setFiltersHydrated] = useState(false);
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [setupDrawerOpen, setSetupDrawerOpen] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(
    () => new Set(candidates.slice(0, 2).map((c) => c.candidateKey)),
  );
  const defaultExpandedKeyList = candidates
    .slice(0, 2)
    .map((c) => c.candidateKey);
  const defaultExpandedSignature = defaultExpandedKeyList.join('\u0000');

  const filterStorageKey = `hirearchy:org:candidates-filters:v1:${organizationId}`;

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const params = new URLSearchParams(window.location.search);
      const hasUrlParams =
        params.has('q') ||
        params.has('status') ||
        params.has('role') ||
        params.has('sort');
      const saved = readPersistedJson<{
        searchQuery?: string;
        statusFilter?: PipelineStatusId;
        roleFilter?: string;
        experienceFilter?: string;
        yearsFilter?: string;
        locationFilter?: string;
        selectedSkills?: string[];
        sortBy?: CandidateSortId;
        moreFiltersOpen?: boolean;
        expandedKeys?: string[];
      }>(filterStorageKey, 'session');
      if (hasUrlParams) {
        const q = params.get('q');
        const st = params.get('status') as PipelineStatusId | null;
        const role = params.get('role');
        const sort = params.get('sort') as CandidateSortId | null;
        if (q) setSearchQuery(q);
        if (st && PIPELINE_STATUS_OPTIONS.some((item) => item.id === st)) {
          setStatusFilter(st);
        }
        if (role) setRoleFilter(role);
        if (sort && CANDIDATE_SORT_OPTIONS.some((item) => item.id === sort)) {
          setSortBy(sort);
        }
        if (typeof saved?.moreFiltersOpen === 'boolean') {
          setMoreFiltersOpen(saved.moreFiltersOpen);
        } else if (role || (sort && sort !== 'recent')) {
          setMoreFiltersOpen(true);
        }
      } else if (saved && typeof saved === 'object') {
        if (typeof saved.searchQuery === 'string') {
          setSearchQuery(saved.searchQuery);
        }
        if (
          saved.statusFilter &&
          PIPELINE_STATUS_OPTIONS.some((item) => item.id === saved.statusFilter)
        ) {
          setStatusFilter(saved.statusFilter);
        }
        if (typeof saved.roleFilter === 'string') {
          setRoleFilter(saved.roleFilter);
        }
        if (typeof saved.experienceFilter === 'string') {
          setExperienceFilter(saved.experienceFilter);
        }
        if (typeof saved.yearsFilter === 'string') {
          setYearsFilter(saved.yearsFilter);
        }
        if (typeof saved.locationFilter === 'string') {
          setLocationFilter(saved.locationFilter);
        }
        if (Array.isArray(saved.selectedSkills)) {
          setSelectedSkills(
            saved.selectedSkills.filter(
              (item): item is string => typeof item === 'string',
            ),
          );
        }
        if (
          saved.sortBy &&
          CANDIDATE_SORT_OPTIONS.some((item) => item.id === saved.sortBy)
        ) {
          setSortBy(saved.sortBy);
        }
        if (typeof saved.moreFiltersOpen === 'boolean') {
          setMoreFiltersOpen(saved.moreFiltersOpen);
        } else if (
          (saved.roleFilter && saved.roleFilter !== 'all') ||
          (saved.experienceFilter && saved.experienceFilter !== 'all') ||
          (saved.yearsFilter && saved.yearsFilter !== 'all') ||
          (saved.locationFilter && saved.locationFilter !== 'all') ||
          (Array.isArray(saved.selectedSkills) &&
            saved.selectedSkills.length > 0) ||
          (saved.sortBy && saved.sortBy !== 'recent')
        ) {
          setMoreFiltersOpen(true);
        }
      }
      if (
        saved &&
        typeof saved === 'object' &&
        Array.isArray(saved.expandedKeys)
      ) {
        setExpandedKeys(
          new Set(
            saved.expandedKeys.filter(
              (item): item is string => typeof item === 'string',
            ),
          ),
        );
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
    if (roleFilter !== 'all') url.searchParams.set('role', roleFilter);
    else url.searchParams.delete('role');
    if (sortBy !== 'recent') url.searchParams.set('sort', sortBy);
    else url.searchParams.delete('sort');
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}`,
    );

    const defaultExpandedKeys = defaultExpandedSignature
      ? defaultExpandedSignature.split('\u0000')
      : [];
    const expandedChanged =
      defaultExpandedKeys.length > 0
        ? expandedKeys.size !== defaultExpandedKeys.length ||
          defaultExpandedKeys.some((key) => !expandedKeys.has(key))
        : expandedKeys.size > 0;
    const hasActiveState =
      searchQuery.trim().length > 0 ||
      selectedSkills.length > 0 ||
      roleFilter !== 'all' ||
      statusFilter !== 'all' ||
      experienceFilter !== 'all' ||
      yearsFilter !== 'all' ||
      locationFilter !== 'all' ||
      sortBy !== 'recent' ||
      moreFiltersOpen ||
      expandedChanged;
    if (!hasActiveState) {
      removePersistedKey(filterStorageKey);
      return;
    }
    writePersistedJson(
      filterStorageKey,
      {
        searchQuery,
        statusFilter,
        roleFilter,
        experienceFilter,
        yearsFilter,
        locationFilter,
        selectedSkills,
        sortBy,
        moreFiltersOpen,
        expandedKeys: Array.from(expandedKeys),
      },
      'session',
    );
  }, [
    defaultExpandedSignature,
    expandedKeys,
    experienceFilter,
    filterStorageKey,
    filtersHydrated,
    locationFilter,
    moreFiltersOpen,
    roleFilter,
    searchQuery,
    selectedSkills,
    sortBy,
    statusFilter,
    yearsFilter,
  ]);

  const choices = useMemo(() => {
    const unique = (values: readonly string[]) =>
      [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));

    return {
      roles: unique(
        candidates.flatMap((c) => [
          c.headlineRole,
          ...c.sessions.map((s) => s.targetRole),
        ]),
      ),
      locations: unique(
        candidates.flatMap((c) => [c.locationCountry, c.locationCity]),
      ),
      skills: unique(candidates.flatMap((c) => c.skills)),
      years: [
        ...new Set(
          candidates.flatMap((c) =>
            c.yearsExperience === null ? [] : [c.yearsExperience],
          ),
        ),
      ].sort((a, b) => a - b),
    };
  }, [candidates]);

  const criteria = {
    role: roleFilter,
    status: decidedOnly ? ('all' as PipelineStatusId) : statusFilter,
    experienceLevel: experienceFilter,
    minimumYears: yearsFilter === 'all' ? null : Number(yearsFilter),
    location: locationFilter,
    skills: selectedSkills,
    sort: sortBy,
  };
  const baseFiltered = filterAndSortCandidates(candidates, criteria).filter(
    (candidate) =>
      !decidedOnly ||
      candidate.sessions.some(
        (sess) =>
          matchesCandidateSessionFilters(candidate, sess, criteria) &&
          (sess.pipelineStatus === 'accepted' ||
            sess.pipelineStatus === 'rejected'),
      ),
  );
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filtered = normalizedQuery
    ? baseFiltered.filter(
        (candidate) =>
          candidate.fullName.toLowerCase().includes(normalizedQuery) ||
          candidate.email.toLowerCase().includes(normalizedQuery) ||
          candidate.headlineRole.toLowerCase().includes(normalizedQuery) ||
          candidate.sessions.some(
            (sess) =>
              sess.scenarioTitle.toLowerCase().includes(normalizedQuery) ||
              sess.targetRole.toLowerCase().includes(normalizedQuery),
          ),
      )
    : baseFiltered;
  const isFiltered =
    decidedOnly ||
    normalizedQuery.length > 0 ||
    selectedSkills.length > 0 ||
    [
      roleFilter,
      statusFilter,
      experienceFilter,
      locationFilter,
      yearsFilter,
    ].some((filter) => filter !== 'all') ||
    sortBy !== 'recent';

  const toggleExpanded = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const clearFilters = () => {
    setRoleFilter('all');
    setStatusFilter('all');
    setDecidedOnly(false);
    setExperienceFilter('all');
    setYearsFilter('all');
    setLocationFilter('all');
    setSelectedSkills([]);
    setSortBy('recent');
    setSearchQuery('');
    setMoreFiltersOpen(false);
    removePersistedKey(filterStorageKey);
  };

  const orgBase = `/r23/organizations/${encodeURIComponent(organizationId)}`;
  const decisionsCount = useMemo(
    () =>
      candidates.filter((candidate) =>
        candidate.sessions.some((sess) => sess.decision !== null),
      ).length,
    [candidates],
  );

  const myPendingPeerReviews = useMemo(() => {
    if (!currentPrincipalId) return [];
    const items: Array<{
      opinionId: string;
      sessionId: string;
      candidateName: string;
      targetRole: string;
      scenarioTitle: string;
      requestedByName: string;
      requestNote: string;
      createdAt: string;
    }> = [];
    for (const candidate of candidates) {
      for (const sess of candidate.sessions) {
        for (const op of sess.secondOpinions) {
          if (
            op.status === 'pending' &&
            op.requestedReviewerPrincipalId === currentPrincipalId
          ) {
            items.push({
              opinionId: op.id,
              sessionId: sess.sessionId,
              candidateName: candidate.fullName,
              targetRole: sess.targetRole,
              scenarioTitle: sess.scenarioTitle,
              requestedByName: op.requestedByName,
              requestNote: op.requestNote,
              createdAt: op.createdAt,
            });
          }
        }
      }
    }
    return items;
  }, [candidates, currentPrincipalId]);

  const readyCount = candidates.reduce(
    (count, candidate) =>
      count +
      candidate.sessions.filter(
        (session) => session.pipelineStatus === 'ready_for_review',
      ).length,
    0,
  );
  const inProgressCount = candidates.reduce(
    (count, candidate) =>
      count +
      candidate.sessions.filter(
        (session) => session.pipelineStatus === 'in_progress',
      ).length,
    0,
  );
  const decidedSessionCount = candidates.reduce(
    (count, candidate) =>
      count +
      candidate.sessions.filter(
        (session) =>
          session.pipelineStatus === 'accepted' ||
          session.pipelineStatus === 'rejected',
      ).length,
    0,
  );

  const renderSession = (sess: OrgCandidateSessionItem) => {
    const canReviewEvidence = sess.lifecycleStatus === 'SUBMITTED';
    const reviewHref = canReviewEvidence
      ? `/r27/organizations/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(sess.sessionId)}`
      : `${orgBase}/sessions/${encodeURIComponent(sess.sessionId)}`;
    return (
      <div
        key={sess.sessionId}
        className="hiring-session-subrow"
        data-stage={sess.pipelineStatus}
      >
        <div>
          <strong>{sess.scenarioTitle}</strong>
          <div className="hiring-candidate-meta">
            <span>{sess.targetRole}</span>
            <span
              title={formatLocalDateTime(sess.submittedAt ?? sess.createdAt)}
            >
              {sess.submittedAt ? 'Submitted' : 'Issued'}{' '}
              {formatRelativeTime(sess.submittedAt ?? sess.createdAt) ||
                formatDateShort(sess.submittedAt ?? sess.createdAt)}
            </span>
            <span>
              {sess.assignedReviewerPrincipalId &&
              sess.assignedReviewerPrincipalId === currentPrincipalId
                ? 'Assigned to you'
                : sess.assignedReviewerName
                  ? `Reviewer: ${sess.assignedReviewerName}`
                  : 'No reviewer assigned'}
            </span>
          </div>
        </div>

        <div className="hiring-chip-group">
          <span className={statusPillClass(sess.pipelineStatus)}>
            {statusLabel(sess.pipelineStatus)}
          </span>
          {sess.secondOpinions.length > 0
            ? (() => {
                const pending = sess.secondOpinions.filter(
                  (o) => o.status === 'pending',
                );
                const approved = sess.secondOpinions.filter(
                  (o) => o.status === 'completed' && o.verdict === 'approve',
                );
                const flagged = sess.secondOpinions.filter(
                  (o) =>
                    o.status === 'completed' && o.verdict === 'request_changes',
                );
                const pillClass =
                  flagged.length > 0
                    ? 'hiring-pill hiring-pill-danger'
                    : approved.length > 0 && pending.length === 0
                      ? 'hiring-pill hiring-pill-success'
                      : pending.length > 0
                        ? 'hiring-pill hiring-pill-warning'
                        : 'hiring-pill';
                const label =
                  flagged.length > 0
                    ? `${flagged.length} concern${flagged.length === 1 ? '' : 's'} flagged`
                    : pending.length > 0
                      ? `${pending.length} peer review${pending.length === 1 ? '' : 's'} pending`
                      : approved.length > 0
                        ? `${approved.length} peer approved`
                        : `${sess.secondOpinions.length} peer review${sess.secondOpinions.length === 1 ? '' : 's'}`;
                return (
                  <span className={pillClass}>
                    <IconUserCheck size={12} aria-hidden="true" /> {label}
                  </span>
                );
              })()
            : null}
        </div>

        <div className="hiring-header-actions">
          {sess.candidateLink ? (
            <CopyActionButton
              value={
                typeof window !== 'undefined'
                  ? `${window.location.origin}${sess.candidateLink}`
                  : sess.candidateLink
              }
              label="Copy invite link"
              copiedLabel="Copied"
              toastMessage="Candidate invite link copied."
              size="sm"
              variant="secondary"
            />
          ) : null}
          {sess.decision?.decision === 'accepted' ? (
            <Link
              className="hiring-btn hiring-btn-sm hiring-btn-mint"
              href={`${orgBase}/handoffs/${encodeURIComponent(sess.sessionId)}`}
            >
              Open Handoff
            </Link>
          ) : null}
          <a
            className={`hiring-btn hiring-btn-sm${sess.pipelineStatus === 'ready_for_review' ? ' hiring-btn-primary' : ''}`}
            href={reviewHref}
          >
            {canReviewEvidence ? 'Review submission' : 'Inspect session'}
          </a>
        </div>
      </div>
    );
  };

  return (
    <div className="hiring-page-shell team-candidate-pipeline">
      {candidates.length === 0 ? (
        <>
          <OrgNudgeBanner organizationId={organizationId} />

          <OrgActivationChecklist
            organizationId={organizationId}
            planTier={plan.planTier}
            currentRole={currentRole}
            candidatesCount={candidates.length}
            decisionsCount={decisionsCount}
          />

          <OrgBenchmarksStrip organizationId={organizationId} compact />
        </>
      ) : (
        <div className="team-top-utility-strip">
          <OrgNudgeBanner organizationId={organizationId} />
          {setupDrawerOpen ? (
            <div className="team-setup-drawer hiring-stack-sm ct-enter-crossfade">
              <OrgActivationChecklist
                organizationId={organizationId}
                planTier={plan.planTier}
                currentRole={currentRole}
                candidatesCount={candidates.length}
                decisionsCount={decisionsCount}
              />
              <OrgBenchmarksStrip organizationId={organizationId} compact />
            </div>
          ) : null}
        </div>
      )}

      {myPendingPeerReviews.length > 0 ? (
        <section
          className="hiring-card hiring-peer-queue-card"
          aria-labelledby="pending-peer-reviews-title"
          data-testid="pending-peer-reviews-queue"
        >
          <div className="hiring-peer-section-head">
            <div>
              <span className="hiring-eyebrow">Assigned to you</span>
              <h2 id="pending-peer-reviews-title">
                Peer reviews requested from you ({myPendingPeerReviews.length})
              </h2>
            </div>
          </div>
          <div className="hiring-peer-queue-list">
            {myPendingPeerReviews.map((item) => (
              <div key={item.opinionId} className="hiring-peer-queue-row">
                <div>
                  <div className="hiring-candidate-name">
                    <strong>{item.candidateName}</strong>
                    <span className="hiring-pill hiring-pill-warning">
                      Peer review pending
                    </span>
                  </div>
                  <div className="hiring-candidate-meta">
                    <span>Requested by {item.requestedByName}</span>
                    <span>{item.targetRole}</span>
                    <span>{item.scenarioTitle}</span>
                  </div>
                  {item.requestNote ? (
                    <p className="hiring-peer-queue-note">
                      “{item.requestNote}”
                    </p>
                  ) : null}
                </div>
                <a
                  className="hiring-btn hiring-btn-sm hiring-btn-primary"
                  href={`/r27/organizations/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(item.sessionId)}?tab=review&peerReview=${encodeURIComponent(item.opinionId)}`}
                >
                  Open peer review →
                </a>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {plan.planTier === 'none' ? (
        <div className="hiring-banner hiring-banner-warning" role="status">
          <span>Activate an organization plan to issue assessments.</span>
          {currentRole === 'cto' ? (
            <Link className="hiring-btn hiring-btn-sm" href={`${orgBase}/plan`}>
              Set up plan
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className="hiring-page-shell">
        {candidates.length > 0 ? (
          <>
            <div
              className="team-pipeline-pulse-bar"
              role="region"
              aria-label="Pipeline summary"
            >
              <div
                className="team-pulse-pills"
                role="group"
                aria-label="Quick status filters"
              >
                <button
                  type="button"
                  className="hiring-btn hiring-btn-sm team-pulse-pill"
                  aria-pressed={!decidedOnly && statusFilter === 'all'}
                  onClick={() => {
                    setDecidedOnly(false);
                    setStatusFilter('all');
                  }}
                >
                  All{' '}
                  <span className="tabular-nums">({candidates.length})</span>
                </button>
                <button
                  type="button"
                  className="hiring-btn hiring-btn-sm team-pulse-pill team-review-filter"
                  aria-pressed={
                    !decidedOnly && statusFilter === 'ready_for_review'
                  }
                  onClick={() => {
                    setDecidedOnly(false);
                    setStatusFilter(
                      statusFilter === 'ready_for_review'
                        ? 'all'
                        : 'ready_for_review',
                    );
                  }}
                >
                  <IconEyeCheck size={15} aria-hidden="true" />
                  Ready to review{' '}
                  <span className="tabular-nums">({readyCount})</span>
                </button>
                <button
                  type="button"
                  className="hiring-btn hiring-btn-sm team-pulse-pill"
                  aria-pressed={!decidedOnly && statusFilter === 'in_progress'}
                  onClick={() => {
                    setDecidedOnly(false);
                    setStatusFilter(
                      statusFilter === 'in_progress' ? 'all' : 'in_progress',
                    );
                  }}
                >
                  In progress{' '}
                  <span className="tabular-nums">({inProgressCount})</span>
                </button>
                <button
                  type="button"
                  className="hiring-btn hiring-btn-sm team-pulse-pill"
                  aria-pressed={decidedOnly}
                  onClick={() => {
                    const next = !decidedOnly;
                    setDecidedOnly(next);
                    if (next) setStatusFilter('all');
                  }}
                >
                  Decided{' '}
                  <span className="tabular-nums">({decidedSessionCount})</span>
                </button>
              </div>
              <button
                type="button"
                className="hiring-btn hiring-btn-sm team-setup-summary-pill"
                aria-expanded={setupDrawerOpen}
                onClick={() => setSetupDrawerOpen((prev) => !prev)}
              >
                <IconSparkles size={14} aria-hidden="true" />
                <span>Setup &amp; benchmarks</span>
                <IconChevronDown size={14} aria-hidden="true" />
              </button>
            </div>

            <section
              className="hiring-filter-bar"
              aria-label="Filter candidates"
            >
              <div className="hiring-filter-primary">
                <div className="hiring-field">
                  <label htmlFor="candidate-search">Search</label>
                  <input
                    id="candidate-search"
                    type="search"
                    aria-label="Search candidates"
                    placeholder="Find a candidate…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
                <div className="hiring-field">
                  <label htmlFor="candidate-status">Pipeline stage</label>
                  <select
                    id="candidate-status"
                    value={statusFilter}
                    onChange={(e) => {
                      setDecidedOnly(false);
                      setStatusFilter(e.target.value as PipelineStatusId);
                    }}
                  >
                    {PIPELINE_STATUS_OPTIONS.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.label}
                      </option>
                    ))}
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
                    <label htmlFor="candidate-role">Role</label>
                    <select
                      id="candidate-role"
                      value={roleFilter}
                      onChange={(e) => setRoleFilter(e.target.value)}
                    >
                      <option value="all">All roles</option>
                      {choices.roles.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="hiring-field">
                    <label htmlFor="candidate-sort">Sort by</label>
                    <select
                      id="candidate-sort"
                      value={sortBy}
                      onChange={(e) =>
                        setSortBy(e.target.value as CandidateSortId)
                      }
                    >
                      {CANDIDATE_SORT_OPTIONS.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="hiring-field">
                    <label htmlFor="candidate-experience">
                      Experience level
                    </label>
                    <select
                      id="candidate-experience"
                      value={experienceFilter}
                      onChange={(e) => setExperienceFilter(e.target.value)}
                    >
                      <option value="all">All levels</option>
                      {EXPERIENCE_LEVELS.map((lvl) => (
                        <option key={lvl.id} value={lvl.id}>
                          {lvl.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="hiring-field">
                    <label htmlFor="candidate-location">Location</label>
                    <select
                      id="candidate-location"
                      value={locationFilter}
                      onChange={(e) => setLocationFilter(e.target.value)}
                    >
                      <option value="all">All locations</option>
                      {choices.locations.map((loc) => (
                        <option key={loc} value={loc}>
                          {loc}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="hiring-field">
                    <label htmlFor="candidate-years">Years of experience</label>
                    <select
                      id="candidate-years"
                      value={yearsFilter}
                      onChange={(e) => setYearsFilter(e.target.value)}
                    >
                      <option value="all">Any experience</option>
                      {choices.years.map((years) => (
                        <option key={years} value={years}>
                          {years}+ {years === 1 ? 'year' : 'years'}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="hiring-field">
                    <label htmlFor="candidate-skills">Skills</label>
                    <select
                      id="candidate-skills"
                      value=""
                      onChange={(e) =>
                        setSelectedSkills([...selectedSkills, e.target.value])
                      }
                    >
                      <option value="" disabled>
                        {choices.skills.length > 0
                          ? 'Add a skill'
                          : 'No skills yet'}
                      </option>
                      {choices.skills
                        .filter((skill) => !selectedSkills.includes(skill))
                        .map((skill) => (
                          <option key={skill} value={skill}>
                            {skill}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
              </details>

              {selectedSkills.length > 0 ? (
                <div className="hiring-chip-group" aria-label="Selected skills">
                  {selectedSkills.map((skill) => (
                    <button
                      key={skill}
                      className="hiring-chip is-active"
                      type="button"
                      aria-label={`Remove ${skill} filter`}
                      onClick={() =>
                        setSelectedSkills(
                          selectedSkills.filter((item) => item !== skill),
                        )
                      }
                    >
                      {skill} <IconX size={14} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              ) : null}
              {isFiltered ? (
                <button
                  type="button"
                  className="hiring-btn hiring-btn-sm hiring-clear-filters"
                  onClick={clearFilters}
                >
                  Clear filters
                </button>
              ) : null}
            </section>
          </>
        ) : null}
        <section
          className="software-directory-results"
          aria-label="Matching candidates"
        >
          <div className="hiring-filter-result" role="status">
            {filtered.length}{' '}
            {filtered.length === 1 ? 'candidate' : 'candidates'}
            {filtered.length !== candidates.length
              ? ` of ${candidates.length}`
              : ''}
          </div>

          {filtered.length === 0 ? (
            <div className="hiring-card team-candidate-empty">
              <h2>
                {candidates.length === 0
                  ? 'No candidates yet'
                  : 'No candidates match these filters'}
              </h2>
              <p>
                {candidates.length === 0
                  ? 'Candidates appear here when you send them an assessment.'
                  : 'Try a different search or clear your filters.'}
              </p>
              {candidates.length === 0 ? (
                <article
                  className="hiring-card-subtle org-sample-candidate-card"
                  data-testid="empty-state-sample-candidate"
                >
                  <div className="org-sample-candidate-copy">
                    <span className="hiring-pill hiring-pill-plum">
                      Sample evaluated candidate · Zero credits used
                    </span>
                    <h3>Maya Lin · Senior Backend Engineer</h3>
                    <p className="hiring-muted-copy">
                      Explore a pre-seeded Reservation Moves v3 evaluation with
                      chronological file diffs, test runs, neutral AI logs, and
                      an executive verdict.
                    </p>
                  </div>
                  <div className="hiring-header-actions">
                    <Link
                      className="hiring-btn hiring-btn-sm hiring-btn-primary"
                      href={`${orgBase}/sample-review`}
                    >
                      Explore sample candidate
                    </Link>
                    <Link
                      className="hiring-btn hiring-btn-sm"
                      href={`${orgBase}/builder/candidate-preview`}
                    >
                      Preview as Candidate
                    </Link>
                  </div>
                </article>
              ) : (
                <button
                  type="button"
                  className="hiring-btn"
                  onClick={clearFilters}
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className="hiring-candidate-list">
              {filtered.map((candidate) => {
                const stageFiltered = statusFilter !== 'all' || decidedOnly;
                const matches = (session: OrgCandidateSessionItem) =>
                  matchesCandidateSessionFilters(
                    candidate,
                    session,
                    criteria,
                  ) &&
                  (!decidedOnly ||
                    session.pipelineStatus === 'accepted' ||
                    session.pipelineStatus === 'rejected');
                const readySessions = candidate.sessions.filter(
                  (session) => session.pipelineStatus === 'ready_for_review',
                );
                const matchingSessions = stageFiltered
                  ? candidate.sessions.filter(matches)
                  : [
                      ...readySessions,
                      ...candidate.sessions.filter(
                        (session) =>
                          session.pipelineStatus !== 'ready_for_review',
                      ),
                    ];
                const otherSessions = stageFiltered
                  ? candidate.sessions.filter((session) => !matches(session))
                  : [];
                const expanded =
                  stageFiltered || expandedKeys.has(candidate.candidateKey);
                const cardStatus = decidedOnly
                  ? (matchingSessions[0]?.pipelineStatus ?? 'accepted')
                  : statusFilter !== 'all'
                    ? statusFilter
                    : readySessions.length
                      ? 'ready_for_review'
                      : candidate.latestPipelineStatus;
                const locationLabel = [
                  candidate.locationCity,
                  candidate.locationCountry,
                ]
                  .filter(Boolean)
                  .join(', ');

                return (
                  <article
                    key={candidate.candidateKey}
                    className="hiring-candidate-card"
                  >
                    <div className="hiring-candidate-header">
                      <div className="hiring-candidate-identity">
                        <span className="hiring-avatar" aria-hidden="true">
                          {getInitials(candidate.fullName)}
                        </span>
                        <div>
                          <div className="hiring-candidate-name">
                            <h2>{candidate.fullName}</h2>
                            <span className={statusPillClass(cardStatus)}>
                              {decidedOnly
                                ? `${matchingSessions.length} decided`
                                : stageFiltered
                                  ? `${matchingSessions.length} ${statusLabel(cardStatus).toLowerCase()}`
                                  : readySessions.length
                                    ? `${readySessions.length} ready to review`
                                    : statusLabel(cardStatus)}
                            </span>
                          </div>
                          <div className="hiring-candidate-meta">
                            <span>{candidate.email || 'Unassigned email'}</span>
                            {candidate.email ? (
                              <CopyActionButton
                                value={candidate.email}
                                label="Copy"
                                copiedLabel="Copied"
                                ariaLabel={`Copy ${candidate.email}`}
                                toastMessage={`Copied ${candidate.email}.`}
                                size="sm"
                                variant="ghost"
                                className="team-copy-email"
                              />
                            ) : null}
                            <span>{candidate.headlineRole}</span>
                            <span>
                              {candidate.experienceLevel
                                ? experienceLevelLabel(
                                    candidate.experienceLevel,
                                  )
                                : null}
                              {candidate.yearsExperience !== null
                                ? `${candidate.experienceLevel ? ' · ' : ''}${candidate.yearsExperience} yrs`
                                : ''}
                            </span>
                            {candidate.hasAccount ? null : (
                              <span>Awaiting signup</span>
                            )}
                            {locationLabel ? (
                              <span>
                                <IconMapPin size={12} /> {locationLabel}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      <div className="hiring-chip-group">
                        {candidate.skills.map((skill) => (
                          <span key={skill} className="hiring-pill">
                            {skill}
                          </span>
                        ))}
                      </div>

                      {!stageFiltered ? (
                        <button
                          type="button"
                          className="hiring-btn hiring-btn-sm team-assessments-toggle"
                          onClick={() => toggleExpanded(candidate.candidateKey)}
                          aria-expanded={expanded}
                        >
                          {candidate.sessions.length} assessment
                          {candidate.sessions.length === 1 ? '' : 's'}
                          <IconChevronDown size={15} aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>

                    <div
                      className="team-assessments-disclosure"
                      data-expanded={expanded}
                      inert={!expanded}
                    >
                      <div className="hiring-session-sublist">
                        {matchingSessions.map(renderSession)}
                        {otherSessions.length > 0 ? (
                          <details className="hiring-other-assessments">
                            <summary>
                              {otherSessions.length} other assessment
                              {otherSessions.length === 1 ? '' : 's'}
                            </summary>
                            <div className="hiring-session-sublist">
                              {otherSessions.map(renderSession)}
                            </div>
                          </details>
                        ) : null}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
