'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  IconChevronDown,
  IconChevronRight,
  IconMapPin,
  IconUserCheck,
  IconX,
} from '@tabler/icons-react';

import { filterAndSortCandidates } from '../../../../../src/hiring/candidates-view';
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
  WorkspaceRoleKind,
} from '../../../../../src/hiring/types';
import { type OrganizationPlanSummary } from '../../../../../src/plans/entitlements';

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
  const [experienceFilter, setExperienceFilter] = useState('all');
  const [yearsFilter, setYearsFilter] = useState('all');
  const [locationFilter, setLocationFilter] = useState('all');
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<CandidateSortId>('recent');
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(
    () => new Set(candidates.slice(0, 1).map((c) => c.candidateKey)),
  );

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

  const filtered = filterAndSortCandidates(candidates, {
    role: roleFilter,
    status: statusFilter,
    experienceLevel: experienceFilter,
    minimumYears: yearsFilter === 'all' ? null : Number(yearsFilter),
    location: locationFilter,
    skills: selectedSkills,
    sort: sortBy,
  });
  const isFiltered =
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
    setExperienceFilter('all');
    setYearsFilter('all');
    setLocationFilter('all');
    setSelectedSkills([]);
    setSortBy('recent');
  };

  const orgBase = `/r23/organizations/${encodeURIComponent(organizationId)}`;

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

  return (
    <div className="hiring-page-shell">
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
            <Link
              className="hiring-btn hiring-btn-sm"
              href={`${orgBase}/settings`}
            >
              Set up plan
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className="software-directory">
        <aside className="hiring-filter-bar" aria-label="Filter candidates">
          <div className="hiring-filter-heading">
            <h2>Candidate filters</h2>
            {isFiltered ? (
              <button
                type="button"
                className="hiring-btn hiring-btn-sm"
                onClick={clearFilters}
              >
                Clear filters
              </button>
            ) : null}
          </div>
          <div className="hiring-filter-grid">
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
                  {choices.skills.length > 0 ? 'Add a skill' : 'No skills yet'}
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
        </aside>
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
            <div className="hiring-card">
              <h2>
                {candidates.length === 0
                  ? 'No candidates yet'
                  : 'No candidates match these filters'}
              </h2>
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
                          </div>
                          <div className="hiring-candidate-meta">
                            <span>{candidate.email || 'Unassigned email'}</span>
                            <span>{candidate.headlineRole}</span>
                            <span>
                              {candidate.experienceLevel
                                ? experienceLevelLabel(
                                    candidate.experienceLevel,
                                  )
                                : 'Level unspecified'}
                              {candidate.yearsExperience !== null
                                ? ` · ${candidate.yearsExperience} yrs`
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
                                      Submitted{' '}
                                      {formatDateShort(sess.submittedAt)}
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
                                  className={statusPillClass(
                                    sess.pipelineStatus,
                                  )}
                                >
                                  {statusLabel(sess.pipelineStatus)}
                                </span>
                                {sess.secondOpinions.length > 0
                                  ? (() => {
                                      const pending =
                                        sess.secondOpinions.filter(
                                          (o) => o.status === 'pending',
                                        );
                                      const approved =
                                        sess.secondOpinions.filter(
                                          (o) =>
                                            o.status === 'completed' &&
                                            o.verdict === 'approve',
                                        );
                                      const flagged =
                                        sess.secondOpinions.filter(
                                          (o) =>
                                            o.status === 'completed' &&
                                            o.verdict === 'request_changes',
                                        );
                                      const pillClass =
                                        flagged.length > 0
                                          ? 'hiring-pill hiring-pill-danger'
                                          : approved.length > 0 &&
                                              pending.length === 0
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
                                          <IconUserCheck
                                            size={12}
                                            aria-hidden="true"
                                          />{' '}
                                          {label}
                                        </span>
                                      );
                                    })()
                                  : null}
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
        </section>
      </div>
    </div>
  );
}
