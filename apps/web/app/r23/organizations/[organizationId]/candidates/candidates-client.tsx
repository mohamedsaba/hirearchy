'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  IconChevronDown,
  IconChevronRight,
  IconMapPin,
  IconShieldCheck,
  IconUserCheck,
} from '@tabler/icons-react';

import {
  computeCandidateKpis,
  filterAndSortCandidates,
} from '../../../../../src/hiring/candidates-view';
import {
  CANDIDATE_SORT_OPTIONS,
  CURATED_COUNTRIES,
  CURATED_SKILLS,
  EXPERIENCE_LEVELS,
  HIRING_ROLES,
  PIPELINE_STATUS_OPTIONS,
  experienceLevelLabel,
  type CandidateSortId,
  type PipelineStatusId,
} from '../../../../../src/hiring/catalogs';
import type {
  OrgCandidateRecord,
  WorkspaceRoleKind,
} from '../../../../../src/hiring/types';
import {
  formatPlanBadge,
  type OrganizationPlanSummary,
} from '../../../../../src/plans/entitlements';

export interface CandidatesPipelineClientProps {
  readonly organizationId: string;
  readonly initialCandidates: readonly OrgCandidateRecord[];
  readonly plan: OrganizationPlanSummary;
  readonly currentRole: WorkspaceRoleKind;
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
  initialCandidates,
  plan,
  currentRole,
}: CandidatesPipelineClientProps) {
  const [candidates] =
    useState<readonly OrgCandidateRecord[]>(initialCandidates);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<PipelineStatusId>('all');
  const [experienceFilter, setExperienceFilter] = useState('all');
  const [locationFilter, setLocationFilter] = useState('all');
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<CandidateSortId>('recent');
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(
    () => new Set(initialCandidates.slice(0, 3).map((c) => c.candidateKey)),
  );

  const availableRoles = useMemo(() => {
    const roles = new Set<string>(HIRING_ROLES);
    for (const c of candidates) {
      if (c.headlineRole) roles.add(c.headlineRole);
      for (const s of c.sessions) {
        if (s.targetRole) roles.add(s.targetRole);
      }
    }
    return [...roles];
  }, [candidates]);

  const availableLocations = useMemo(() => {
    const locs = new Set<string>(CURATED_COUNTRIES);
    for (const c of candidates) {
      if (c.locationCountry) locs.add(c.locationCountry);
      if (c.locationCity) locs.add(c.locationCity);
    }
    return [...locs];
  }, [candidates]);

  const availableSkills = useMemo(() => {
    const skills = new Set<string>(CURATED_SKILLS);
    for (const c of candidates) {
      for (const skill of c.skills) {
        skills.add(skill);
      }
    }
    return [...skills];
  }, [candidates]);

  const kpis = useMemo(() => computeCandidateKpis(candidates), [candidates]);

  const filtered = useMemo(
    () =>
      filterAndSortCandidates(candidates, {
        search,
        role: roleFilter,
        status: statusFilter,
        experienceLevel: experienceFilter,
        location: locationFilter,
        skills: selectedSkills,
        sort: sortBy,
      }),
    [
      candidates,
      search,
      roleFilter,
      statusFilter,
      experienceFilter,
      locationFilter,
      selectedSkills,
      sortBy,
    ],
  );

  const toggleSkill = (skill: string) => {
    setSelectedSkills((prev) =>
      prev.includes(skill)
        ? prev.filter((item) => item !== skill)
        : [...prev, skill],
    );
  };

  const toggleExpanded = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const clearFilters = () => {
    setSearch('');
    setRoleFilter('all');
    setStatusFilter('all');
    setExperienceFilter('all');
    setLocationFilter('all');
    setSelectedSkills([]);
    setSortBy('recent');
  };

  const orgBase = `/r23/organizations/${encodeURIComponent(organizationId)}`;

  return (
    <div className="hiring-page-shell">
      {plan.planTier === 'none' ? (
        <div className="hiring-banner hiring-banner-warning" role="status">
          <div>
            <strong>No active plan:</strong> Upgrade to Per Candidate, Pro, or
            Ultra before issuing candidate assessments.
          </div>
          <a className="hiring-btn hiring-btn-sm" href={`${orgBase}/settings`}>
            Choose a plan
          </a>
        </div>
      ) : null}

      <section className="hiring-kpi-strip" aria-label="Pipeline metrics">
        <div className="hiring-kpi-card">
          <span className="hiring-kpi-label">Total candidates</span>
          <strong className="hiring-kpi-value">{kpis.totalCandidates}</strong>
          <span className="hiring-kpi-note">
            {currentRole === 'reviewer'
              ? 'Visible to you in workspace'
              : 'Across organization pipeline'}
          </span>
        </div>
        <div className="hiring-kpi-card">
          <span className="hiring-kpi-label">In progress</span>
          <strong className="hiring-kpi-value">{kpis.inProgress}</strong>
          <span className="hiring-kpi-note">Active candidate sessions</span>
        </div>
        <div className="hiring-kpi-card">
          <span className="hiring-kpi-label">Ready for decision</span>
          <strong className="hiring-kpi-value">{kpis.readyForReview}</strong>
          <span className="hiring-kpi-note">
            Submitted &amp; second opinion
          </span>
        </div>
        <div className="hiring-kpi-card">
          <span className="hiring-kpi-label">Accepted · Handoffs</span>
          <strong className="hiring-kpi-value">{kpis.accepted}</strong>
          <span className="hiring-kpi-note">{formatPlanBadge(plan)}</span>
        </div>
      </section>

      <section className="hiring-filter-bar" aria-label="Filter candidates">
        <div className="hiring-filter-grid">
          <div className="hiring-field">
            <label htmlFor="candidate-search">Candidate name or email</label>
            <input
              id="candidate-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="e.g. Laila, @company.com"
            />
          </div>

          <div className="hiring-field">
            <label htmlFor="candidate-role">Position / Role</label>
            <select
              id="candidate-role"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
            >
              <option value="all">All roles</option>
              {availableRoles.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </div>

          <div className="hiring-field">
            <label htmlFor="candidate-status">Pipeline stage</label>
            <select
              id="candidate-status"
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as PipelineStatusId)
              }
            >
              {PIPELINE_STATUS_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="hiring-field">
            <label htmlFor="candidate-experience">Experience level</label>
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
              {availableLocations.map((loc) => (
                <option key={loc} value={loc}>
                  {loc}
                </option>
              ))}
            </select>
          </div>

          <div className="hiring-field">
            <label htmlFor="candidate-sort">Sort by</label>
            <select
              id="candidate-sort"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as CandidateSortId)}
            >
              {CANDIDATE_SORT_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="hiring-field">
          <span className="hiring-field-label">Filter by skills</span>
          <div className="hiring-chip-group">
            {availableSkills.slice(0, 18).map((skill) => {
              const active = selectedSkills.includes(skill);
              return (
                <button
                  key={skill}
                  type="button"
                  className={`hiring-chip${active ? ' is-active' : ''}`}
                  onClick={() => toggleSkill(skill)}
                  aria-pressed={active}
                >
                  {skill}
                </button>
              );
            })}
            {(selectedSkills.length > 0 ||
              roleFilter !== 'all' ||
              statusFilter !== 'all' ||
              experienceFilter !== 'all' ||
              locationFilter !== 'all' ||
              search) && (
              <button
                type="button"
                className="hiring-btn hiring-btn-sm"
                onClick={clearFilters}
              >
                Reset filters
              </button>
            )}
          </div>
        </div>
      </section>

      {filtered.length === 0 ? (
        <div className="hiring-card">
          <h2>No candidates match these filters</h2>
          <p>
            {candidates.length === 0
              ? 'Issue your first assessment from the Assessment Builder to start your candidate pipeline.'
              : 'Try broadening your role, skills, location, or stage filters.'}
          </p>
        </div>
      ) : (
        <div className="hiring-candidate-list">
          {filtered.map((candidate) => {
            const expanded = expandedKeys.has(candidate.candidateKey);
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
                        <span
                          className={statusPillClass(
                            candidate.latestPipelineStatus,
                          )}
                        >
                          {statusLabel(candidate.latestPipelineStatus)}
                        </span>
                        {candidate.idVerificationStatus !== 'unsubmitted' ? (
                          <span className="hiring-pill hiring-pill-success">
                            <IconShieldCheck size={13} /> ID{' '}
                            {candidate.idVerificationStatus}
                          </span>
                        ) : (
                          <span className="hiring-pill">
                            {candidate.hasAccount
                              ? 'Account ready'
                              : 'Pending candidate signup'}
                          </span>
                        )}
                        {candidate.candidateCode ? (
                          <span className="hiring-pill hiring-pill-plum">
                            {candidate.candidateCode}
                          </span>
                        ) : null}
                      </div>
                      <div className="hiring-candidate-meta">
                        <span>{candidate.email || 'Unassigned email'}</span>
                        <span>{candidate.headlineRole}</span>
                        <span>
                          {candidate.experienceLevel
                            ? experienceLevelLabel(candidate.experienceLevel)
                            : 'Level unspecified'}
                          {candidate.yearsExperience !== null
                            ? ` · ${candidate.yearsExperience} yrs`
                            : ''}
                        </span>
                        {candidate.age !== null ? (
                          <span>Age {candidate.age}</span>
                        ) : null}
                        {locationLabel ? (
                          <span>
                            <IconMapPin size={12} /> {locationLabel}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="hiring-chip-group">
                    {candidate.skills.slice(0, 6).map((skill) => (
                      <span key={skill} className="hiring-pill">
                        {skill}
                      </span>
                    ))}
                  </div>

                  <button
                    type="button"
                    className="hiring-btn hiring-btn-sm"
                    onClick={() => toggleExpanded(candidate.candidateKey)}
                    aria-expanded={expanded}
                  >
                    {expanded ? (
                      <>
                        <IconChevronDown size={15} /> Hide{' '}
                        {candidate.sessions.length} assessment
                        {candidate.sessions.length === 1 ? '' : 's'}
                      </>
                    ) : (
                      <>
                        <IconChevronRight size={15} />{' '}
                        {candidate.sessions.length} assessment
                        {candidate.sessions.length === 1 ? '' : 's'}
                      </>
                    )}
                  </button>
                </div>

                {expanded ? (
                  <div className="hiring-session-sublist">
                    {candidate.sessions.map((sess) => {
                      const canReviewEvidence =
                        sess.lifecycleStatus === 'SUBMITTED';
                      const reviewHref = canReviewEvidence
                        ? `/r27/organizations/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(sess.sessionId)}`
                        : `${orgBase}/sessions/${encodeURIComponent(sess.sessionId)}`;
                      return (
                        <div
                          key={sess.sessionId}
                          className="hiring-session-subrow"
                        >
                          <div>
                            <strong>{sess.scenarioTitle}</strong>
                            <div className="hiring-candidate-meta">
                              <span>Role: {sess.targetRole}</span>
                              <span>
                                Issued {formatDateShort(sess.createdAt)}
                              </span>
                              {sess.submittedAt ? (
                                <span>
                                  Submitted {formatDateShort(sess.submittedAt)}
                                </span>
                              ) : null}
                              <span>
                                Reviewer:{' '}
                                {sess.assignedReviewerName ?? 'Unassigned'}
                              </span>
                            </div>
                          </div>

                          <div className="hiring-chip-group">
                            <span
                              className={statusPillClass(sess.pipelineStatus)}
                            >
                              {statusLabel(sess.pipelineStatus)}
                            </span>
                            {sess.secondOpinions.length > 0 ? (
                              <span className="hiring-pill">
                                <IconUserCheck size={12} />{' '}
                                {sess.secondOpinions.length} 2nd opinion
                                {sess.secondOpinions.length === 1 ? '' : 's'}
                              </span>
                            ) : null}
                          </div>

                          <div className="hiring-header-actions">
                            {sess.decision?.decision === 'accepted' ? (
                              <Link
                                className="hiring-btn hiring-btn-sm hiring-btn-mint"
                                href={`${orgBase}/handoffs/${encodeURIComponent(sess.sessionId)}`}
                              >
                                Open Handoff
                              </Link>
                            ) : null}
                            <a
                              className="hiring-btn hiring-btn-sm hiring-btn-primary"
                              href={reviewHref}
                            >
                              {canReviewEvidence
                                ? 'Review & Decide'
                                : 'Inspect Session'}
                            </a>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
