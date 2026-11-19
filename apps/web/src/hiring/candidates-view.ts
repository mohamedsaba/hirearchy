import {
  computeAgeFromBirthYear,
  experienceLevelRank,
  type CandidateSortId,
  type ExperienceLevelId,
  type IdDocumentTypeId,
  type PipelineStatusId,
  type WorkModeId,
} from './catalogs';
import type {
  HiringDecisionRecord,
  OrgCandidateRecord,
  OrgCandidateSessionItem,
  SecondOpinionRecord,
} from './types';

export interface RawHiringCandidateSessionRow {
  readonly sessionId: string;
  readonly candidateEmail?: string | null;
  readonly candidatePrincipalId?: string | null;
  readonly scenarioTitle: string;
  readonly targetRole?: string | null;
  readonly experienceLevel?: string | null;
  readonly skills?: readonly string[] | null;
  readonly durationSeconds?: number | null;
  readonly lifecycleStatus: 'CREATED' | 'ACTIVE' | 'SUBMITTED';
  readonly createdAt: string;
  readonly activatedAt?: string | null;
  readonly submittedAt?: string | null;
  readonly issuerPrincipalId: string;
  readonly issuerName?: string | null;
  readonly assignedReviewerPrincipalId?: string | null;
  readonly assignedReviewerName?: string | null;
  readonly invitationActive?: boolean;
  readonly invitationExpiresAt?: string | null;
  readonly profile?: {
    readonly candidateCode?: string | null;
    readonly fullName?: string | null;
    readonly phone?: string | null;
    readonly birthYear?: number | null;
    readonly locationCountry?: string | null;
    readonly locationCity?: string | null;
    readonly workMode?: string | null;
    readonly headlineRole?: string | null;
    readonly yearsExperience?: number | null;
    readonly experienceLevel?: string | null;
    readonly skills?: readonly string[] | null;
    readonly idDocumentType?: string | null;
    readonly idVerificationStatus?: string | null;
    readonly linkedinUrl?: string | null;
    readonly githubUrl?: string | null;
    readonly portfolioUrl?: string | null;
    readonly bio?: string | null;
  } | null;
  readonly decision?: HiringDecisionRecord | null;
  readonly secondOpinions?: readonly SecondOpinionRecord[] | null;
}

export function deriveSessionPipelineStatus(input: {
  lifecycleStatus: 'CREATED' | 'ACTIVE' | 'SUBMITTED';
  decision?: HiringDecisionRecord | null;
  secondOpinions?: readonly SecondOpinionRecord[] | null;
}): PipelineStatusId {
  if (input.decision?.decision === 'accepted') return 'accepted';
  if (input.decision?.decision === 'rejected') return 'rejected';
  if (
    Array.isArray(input.secondOpinions) &&
    input.secondOpinions.some((item) => item.status === 'pending')
  ) {
    return 'second_opinion';
  }
  if (input.lifecycleStatus === 'SUBMITTED') return 'ready_for_review';
  if (input.lifecycleStatus === 'ACTIVE') return 'in_progress';
  return 'invited';
}

function asExperienceLevel(value: unknown): ExperienceLevelId | null {
  return value === 'junior' ||
    value === 'mid' ||
    value === 'senior' ||
    value === 'staff'
    ? value
    : null;
}

function asWorkMode(value: unknown): WorkModeId | null {
  return value === 'remote' ||
    value === 'hybrid' ||
    value === 'onsite' ||
    value === 'any'
    ? value
    : null;
}

function asIdDocType(value: unknown): IdDocumentTypeId | null {
  return value === 'national_id' ||
    value === 'passport' ||
    value === 'drivers_license'
    ? value
    : null;
}

function displayNameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? 'Candidate';
  const cleaned = local.replace(/[._-]+/g, ' ').trim();
  return cleaned
    ? cleaned.replace(/\b\w/g, (c) => c.toUpperCase())
    : 'Invited Candidate';
}

function pipelineSortOrder(status: PipelineStatusId): number {
  switch (status) {
    case 'ready_for_review':
      return 1;
    case 'second_opinion':
      return 2;
    case 'in_progress':
      return 3;
    case 'invited':
      return 4;
    case 'accepted':
      return 5;
    case 'rejected':
      return 6;
    default:
      return 9;
  }
}

export function groupCandidateSessions(
  rows: readonly RawHiringCandidateSessionRow[],
): OrgCandidateRecord[] {
  const buckets = new Map<
    string,
    {
      candidateKey: string;
      email: string;
      candidatePrincipalId: string | null;
      profile: RawHiringCandidateSessionRow['profile'] | null;
      sessions: OrgCandidateSessionItem[];
    }
  >();

  for (const row of rows) {
    const email = (row.candidateEmail ?? '').trim().toLowerCase();
    const key = email || `session:${row.sessionId}`;
    const secondOpinions = Array.isArray(row.secondOpinions)
      ? row.secondOpinions
      : [];
    const pipelineStatus = deriveSessionPipelineStatus({
      lifecycleStatus: row.lifecycleStatus,
      decision: row.decision ?? null,
      secondOpinions,
    });
    const sessionItem: OrgCandidateSessionItem = {
      sessionId: row.sessionId,
      scenarioTitle: row.scenarioTitle,
      targetRole: row.targetRole?.trim() || 'Software Engineer',
      experienceLevel: row.experienceLevel?.trim() || 'mid',
      skills: Array.isArray(row.skills) ? row.skills : [],
      durationSeconds:
        typeof row.durationSeconds === 'number' ? row.durationSeconds : null,
      lifecycleStatus: row.lifecycleStatus,
      pipelineStatus,
      assignedReviewerPrincipalId: row.assignedReviewerPrincipalId ?? null,
      assignedReviewerName: row.assignedReviewerName ?? null,
      issuerPrincipalId: row.issuerPrincipalId,
      issuerName: row.issuerName ?? 'Team Member',
      createdAt: row.createdAt,
      activatedAt: row.activatedAt ?? null,
      submittedAt: row.submittedAt ?? null,
      invitationActive: Boolean(row.invitationActive),
      invitationExpiresAt: row.invitationExpiresAt ?? null,
      decision: row.decision ?? null,
      secondOpinions,
    };

    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        candidateKey: key,
        email,
        candidatePrincipalId: row.candidatePrincipalId ?? null,
        profile: row.profile ?? null,
        sessions: [sessionItem],
      });
    } else {
      existing.sessions.push(sessionItem);
      if (!existing.candidatePrincipalId && row.candidatePrincipalId) {
        existing.candidatePrincipalId = row.candidatePrincipalId;
      }
      if (!existing.profile && row.profile) {
        existing.profile = row.profile;
      }
    }
  }

  const results: OrgCandidateRecord[] = [];
  for (const bucket of buckets.values()) {
    bucket.sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latest = bucket.sessions[0];
    const p = bucket.profile;
    const mergedSkills = new Set<string>();
    for (const s of p?.skills ?? []) {
      if (s.trim()) mergedSkills.add(s.trim());
    }
    for (const sess of bucket.sessions) {
      for (const s of sess.skills) {
        if (s.trim()) mergedSkills.add(s.trim());
      }
    }

    const latestSubmittedAt =
      bucket.sessions
        .map((s) => s.submittedAt)
        .filter((d): d is string => Boolean(d))
        .sort()
        .at(-1) ?? null;

    const lastActivityAt = bucket.sessions.reduce((best, s) => {
      const candidateTs =
        s.decision?.updatedAt ?? s.submittedAt ?? s.activatedAt ?? s.createdAt;
      return candidateTs > best ? candidateTs : best;
    }, latest.createdAt);

    const idVerificationStatus =
      p?.idVerificationStatus === 'verified'
        ? 'verified'
        : p?.idVerificationStatus === 'submitted'
          ? 'submitted'
          : 'unsubmitted';

    results.push({
      candidateKey: bucket.candidateKey,
      email: bucket.email,
      candidatePrincipalId: bucket.candidatePrincipalId,
      candidateCode: p?.candidateCode ?? null,
      fullName:
        p?.fullName?.trim() ||
        (bucket.email ? displayNameFromEmail(bucket.email) : 'Candidate'),
      hasAccount: Boolean(
        p?.fullName || p?.candidateCode || bucket.candidatePrincipalId,
      ),
      headlineRole: p?.headlineRole?.trim() || latest.targetRole,
      yearsExperience:
        typeof p?.yearsExperience === 'number' ? p.yearsExperience : null,
      experienceLevel:
        asExperienceLevel(p?.experienceLevel) ??
        asExperienceLevel(latest.experienceLevel),
      locationCountry: p?.locationCountry?.trim() ?? '',
      locationCity: p?.locationCity?.trim() ?? '',
      workMode: asWorkMode(p?.workMode),
      skills: [...mergedSkills],
      idVerificationStatus,
      idDocumentType: asIdDocType(p?.idDocumentType),
      age: computeAgeFromBirthYear(p?.birthYear),
      phone: p?.phone?.trim() ?? '',
      linkedinUrl: p?.linkedinUrl?.trim() ?? '',
      githubUrl: p?.githubUrl?.trim() ?? '',
      portfolioUrl: p?.portfolioUrl?.trim() ?? '',
      bio: p?.bio?.trim() ?? '',
      latestPipelineStatus: latest.pipelineStatus,
      lastActivityAt,
      latestSubmittedAt,
      sessions: bucket.sessions,
    });
  }

  return results.sort((a, b) =>
    b.lastActivityAt.localeCompare(a.lastActivityAt),
  );
}

export interface CandidateFilterCriteria {
  readonly search: string;
  readonly role: string;
  readonly status: PipelineStatusId;
  readonly experienceLevel: string;
  readonly location: string;
  readonly skills: readonly string[];
  readonly sort: CandidateSortId;
}

export function filterAndSortCandidates(
  candidates: readonly OrgCandidateRecord[],
  criteria: CandidateFilterCriteria,
): OrgCandidateRecord[] {
  const searchQuery = criteria.search.trim().toLowerCase();
  const filtered = candidates.filter((candidate) => {
    if (searchQuery) {
      const hay =
        `${candidate.fullName} ${candidate.email} ${candidate.candidateCode ?? ''} ${candidate.headlineRole}`.toLowerCase();
      if (!hay.includes(searchQuery)) return false;
    }
    if (criteria.role !== 'all') {
      const matchesRole =
        candidate.headlineRole === criteria.role ||
        candidate.sessions.some((s) => s.targetRole === criteria.role);
      if (!matchesRole) return false;
    }
    if (criteria.status !== 'all') {
      const matchesStatus = candidate.sessions.some(
        (s) => s.pipelineStatus === criteria.status,
      );
      if (!matchesStatus) return false;
    }
    if (criteria.experienceLevel !== 'all') {
      const matchesLevel =
        candidate.experienceLevel === criteria.experienceLevel ||
        candidate.sessions.some(
          (s) => s.experienceLevel === criteria.experienceLevel,
        );
      if (!matchesLevel) return false;
    }
    if (criteria.location !== 'all') {
      const locText =
        `${candidate.locationCountry} ${candidate.locationCity}`.toLowerCase();
      if (!locText.includes(criteria.location.toLowerCase())) return false;
    }
    if (criteria.skills.length > 0) {
      const lowerSkills = new Set(candidate.skills.map((s) => s.toLowerCase()));
      for (const reqSkill of criteria.skills) {
        if (!lowerSkills.has(reqSkill.toLowerCase())) return false;
      }
    }
    return true;
  });

  const sorted = [...filtered];
  sorted.sort((a, b) => {
    switch (criteria.sort) {
      case 'submitted_desc':
        return (b.latestSubmittedAt ?? '').localeCompare(
          a.latestSubmittedAt ?? '',
        );
      case 'experience_desc': {
        const expA =
          a.yearsExperience ?? experienceLevelRank(a.experienceLevel);
        const expB =
          b.yearsExperience ?? experienceLevelRank(b.experienceLevel);
        return expB - expA;
      }
      case 'experience_asc': {
        const expA =
          a.yearsExperience ?? experienceLevelRank(a.experienceLevel);
        const expB =
          b.yearsExperience ?? experienceLevelRank(b.experienceLevel);
        return expA - expB;
      }
      case 'status':
        return (
          pipelineSortOrder(a.latestPipelineStatus) -
          pipelineSortOrder(b.latestPipelineStatus)
        );
      case 'name_asc':
        return a.fullName.localeCompare(b.fullName);
      case 'recent':
      default:
        return b.lastActivityAt.localeCompare(a.lastActivityAt);
    }
  });
  return sorted;
}

export function computeCandidateKpis(
  candidates: readonly OrgCandidateRecord[],
) {
  let inProgress = 0;
  let readyForReview = 0;
  let accepted = 0;
  for (const c of candidates) {
    if (c.latestPipelineStatus === 'in_progress') inProgress += 1;
    if (
      c.latestPipelineStatus === 'ready_for_review' ||
      c.latestPipelineStatus === 'second_opinion'
    ) {
      readyForReview += 1;
    }
    if (c.latestPipelineStatus === 'accepted') accepted += 1;
  }
  return {
    totalCandidates: candidates.length,
    inProgress,
    readyForReview,
    accepted,
  };
}
