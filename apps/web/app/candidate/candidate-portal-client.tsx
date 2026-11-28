'use client';

import Link from 'next/link';
import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import {
  IconCheck,
  IconClock,
  IconLogout,
  IconPlayerPlay,
  IconUser,
} from '@tabler/icons-react';

import {
  CURATED_COUNTRIES,
  CURATED_SKILLS,
  EXPERIENCE_LEVELS,
  HIRING_ROLES,
  WORK_MODES,
  YEARS_EXPERIENCE_OPTIONS,
  experienceLevelLabel,
  type ExperienceLevelId,
  type PipelineStatusId,
  type WorkModeId,
} from '../../src/hiring/catalogs';
import type {
  CandidateProfile,
  SafePortalAssessmentView,
} from '../../src/hiring/types';
import {
  readPersistedJson,
  removePersistedKey,
  writePersistedJson,
} from '../../src/ui/browser-state';
import {
  formatLocalDateTime,
  formatRelativeTime,
} from '../../src/ui/relative-time';
import { emitToast } from '../_components/brand-toast';
import { CandidateOutcome } from '../_components/candidate-outcome';
import { HorizontalTabs } from '../_components/horizontal-tabs';
import { LocalTime } from '../_components/local-time';
import { ThemeToggle } from '../_components/theme-toggle';

export interface CandidatePortalClientProps {
  readonly email: string;
  readonly initialProfile: CandidateProfile | null;
  readonly initialAssessments: readonly SafePortalAssessmentView[];
  readonly setupMode: boolean;
  readonly nextPath: string | null;
}

function readCsrfCookie(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)__Host-r23-csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function portalStatusBadgeClass(status: PipelineStatusId): string {
  switch (status) {
    case 'accepted':
      return 'hiring-pill hiring-pill-success';
    case 'rejected':
      return 'hiring-pill hiring-pill-danger';
    case 'in_progress':
      return 'hiring-pill hiring-pill-warning';
    case 'ready_for_review':
    case 'second_opinion':
      return 'hiring-pill hiring-pill-plum';
    default:
      return 'hiring-pill';
  }
}

const candidateStatusLabels: Record<PipelineStatusId, string> = {
  all: 'All statuses',
  invited: 'Invited',
  in_progress: 'In progress',
  ready_for_review: 'Submitted',
  second_opinion: 'Submitted',
  accepted: 'Accepted',
  rejected: 'Rejected',
};

const candidateStageOrder: Record<PipelineStatusId, number> = {
  invited: 0,
  in_progress: 1,
  ready_for_review: 2,
  second_opinion: 3,
  accepted: 4,
  rejected: 5,
  all: 6,
};

function assessmentPriorityRank(item: SafePortalAssessmentView): number {
  if (item.status === 'ACTIVE' && item.canLaunch) return 0;
  if (item.status === 'CREATED' && item.canLaunch) return 1;
  if (item.status !== 'SUBMITTED') return 2;
  return 3;
}

function compareAssessmentsByPriority(
  a: SafePortalAssessmentView,
  b: SafePortalAssessmentView,
): number {
  const rankDiff = assessmentPriorityRank(a) - assessmentPriorityRank(b);
  if (rankDiff !== 0) return rankDiff;
  if (a.status === 'CREATED' && b.status === 'CREATED') {
    const aExp = a.invitationExpiresAt ?? '9999-12-31T23:59:59Z';
    const bExp = b.invitationExpiresAt ?? '9999-12-31T23:59:59Z';
    const expDiff = aExp.localeCompare(bExp);
    if (expDiff !== 0) return expDiff;
  }
  const aStamp = a.activatedAt ?? a.submittedAt ?? a.createdAt;
  const bStamp = b.activatedAt ?? b.submittedAt ?? b.createdAt;
  return bStamp.localeCompare(aStamp);
}

function formatExpiresCountdown(iso: string | null | undefined): {
  label: string;
  urgent: boolean;
} | null {
  if (!iso) return null;
  const targetMs = Date.parse(iso);
  if (!Number.isFinite(targetMs)) return null;
  const diffMs = targetMs - Date.now();
  if (diffMs <= 0) return { label: 'Expired', urgent: true };
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 1) {
    const mins = Math.max(1, Math.ceil(diffMs / 60_000));
    return { label: `Expires in ${mins}m`, urgent: true };
  }
  if (hours < 48) {
    return { label: `Expires in ${hours}h`, urgent: hours <= 24 };
  }
  const days = Math.ceil(hours / 24);
  return { label: `Expires in ${days}d`, urgent: days <= 2 };
}

export function CandidatePortalClient({
  email,
  initialProfile,
  initialAssessments,
  setupMode,
  nextPath,
}: CandidatePortalClientProps) {
  const [profile, setProfile] = useState<CandidateProfile | null>(
    initialProfile,
  );
  const [assessments] =
    useState<readonly SafePortalAssessmentView[]>(initialAssessments);
  const [pendingLaunchSessionId, setPendingLaunchSessionId] = useState<
    string | null
  >(() => (nextPath ? (nextPath.split('/').at(-1) ?? null) : null));
  const [tab, setTab] = useState<'assessments' | 'profile'>(
    setupMode && initialAssessments.length > 0 ? 'profile' : 'assessments',
  );

  // Filters on Assessments tab
  const [showFilters, setShowFilters] = useState(false);
  const [statusFilter, setStatusFilter] = useState<PipelineStatusId>('all');
  const [companyFilter, setCompanyFilter] = useState('all');
  const [roleFilter, setRoleFilter] = useState('all');
  const [sortBy, setSortBy] = useState<
    'priority' | 'recent' | 'company' | 'status'
  >('priority');

  const firstActionableAssessment = useMemo(
    () =>
      [...initialAssessments]
        .sort(compareAssessmentsByPriority)
        .find((item) => item.canLaunch) ?? initialAssessments[0],
    [initialAssessments],
  );

  // Editable Profile fields
  const [fullName, setFullName] = useState(initialProfile?.fullName ?? '');
  const [phone, setPhone] = useState(initialProfile?.phone ?? '');
  const [locationCountry, setLocationCountry] = useState(
    initialProfile?.locationCountry ?? '',
  );
  const [locationCity, setLocationCity] = useState(
    initialProfile?.locationCity ?? '',
  );
  const [workMode, setWorkMode] = useState<WorkModeId>(
    initialProfile?.workMode ?? 'any',
  );
  const [headlineRole, setHeadlineRole] = useState(
    initialProfile?.headlineRole || firstActionableAssessment?.targetRole || '',
  );
  const [yearsExperience, setYearsExperience] = useState(
    initialProfile?.yearsExperience?.toString() ?? '',
  );
  const [experienceLevel, setExperienceLevel] = useState<
    ExperienceLevelId | ''
  >(
    initialProfile?.experienceLevel ||
      (firstActionableAssessment?.experienceLevel as ExperienceLevelId | '') ||
      '',
  );
  const [skills, setSkills] = useState<string[]>([
    ...(initialProfile?.skills ?? []),
  ]);
  const [linkedinUrl, setLinkedinUrl] = useState(
    initialProfile?.linkedinUrl ?? '',
  );
  const [githubUrl, setGithubUrl] = useState(initialProfile?.githubUrl ?? '');
  const [portfolioUrl, setPortfolioUrl] = useState(
    initialProfile?.portfolioUrl ?? '',
  );
  const [bio, setBio] = useState(initialProfile?.bio ?? '');
  const [portalHydrated, setPortalHydrated] = useState(false);

  const normalizedEmail = email.toLowerCase();
  const profileDraftStorageKey = `hirearchy:candidate:profile-draft:v1:${normalizedEmail}`;
  const portalFiltersStorageKey = `hirearchy:candidate:portal-filters:v1:${normalizedEmail}`;

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const params = new URLSearchParams(window.location.search);
      const urlTab = params.get('tab');
      if (!setupMode && (urlTab === 'assessments' || urlTab === 'profile')) {
        setTab(urlTab);
      }

      const savedFilters = readPersistedJson<{
        showFilters?: boolean;
        statusFilter?: PipelineStatusId;
        companyFilter?: string;
        roleFilter?: string;
        sortBy?: 'priority' | 'recent' | 'company' | 'status';
      }>(portalFiltersStorageKey, 'session');
      if (savedFilters && typeof savedFilters === 'object') {
        if (typeof savedFilters.showFilters === 'boolean') {
          setShowFilters(savedFilters.showFilters);
        }
        if (savedFilters.statusFilter) {
          setStatusFilter(savedFilters.statusFilter);
        }
        if (typeof savedFilters.companyFilter === 'string') {
          setCompanyFilter(savedFilters.companyFilter);
        }
        if (typeof savedFilters.roleFilter === 'string') {
          setRoleFilter(savedFilters.roleFilter);
        }
        if (
          savedFilters.sortBy &&
          ['priority', 'recent', 'company', 'status'].includes(
            savedFilters.sortBy,
          )
        ) {
          setSortBy(savedFilters.sortBy);
        }
      }

      const savedProfileDraft = readPersistedJson<{
        fullName?: string;
        phone?: string;
        locationCountry?: string;
        locationCity?: string;
        workMode?: WorkModeId;
        headlineRole?: string;
        yearsExperience?: string;
        experienceLevel?: ExperienceLevelId | '';
        skills?: string[];
        linkedinUrl?: string;
        githubUrl?: string;
        portfolioUrl?: string;
        bio?: string;
      }>(profileDraftStorageKey, 'durable');
      if (savedProfileDraft && typeof savedProfileDraft === 'object') {
        if (typeof savedProfileDraft.fullName === 'string') {
          setFullName(savedProfileDraft.fullName);
        }
        if (typeof savedProfileDraft.phone === 'string') {
          setPhone(savedProfileDraft.phone);
        }
        if (typeof savedProfileDraft.locationCountry === 'string') {
          setLocationCountry(savedProfileDraft.locationCountry);
        }
        if (typeof savedProfileDraft.locationCity === 'string') {
          setLocationCity(savedProfileDraft.locationCity);
        }
        if (savedProfileDraft.workMode) {
          setWorkMode(savedProfileDraft.workMode);
        }
        if (typeof savedProfileDraft.headlineRole === 'string') {
          setHeadlineRole(savedProfileDraft.headlineRole);
        }
        if (typeof savedProfileDraft.yearsExperience === 'string') {
          setYearsExperience(savedProfileDraft.yearsExperience);
        }
        if (savedProfileDraft.experienceLevel !== undefined) {
          setExperienceLevel(savedProfileDraft.experienceLevel);
        }
        if (Array.isArray(savedProfileDraft.skills)) {
          setSkills(savedProfileDraft.skills);
        }
        if (typeof savedProfileDraft.linkedinUrl === 'string') {
          setLinkedinUrl(savedProfileDraft.linkedinUrl);
        }
        if (typeof savedProfileDraft.githubUrl === 'string') {
          setGithubUrl(savedProfileDraft.githubUrl);
        }
        if (typeof savedProfileDraft.portfolioUrl === 'string') {
          setPortfolioUrl(savedProfileDraft.portfolioUrl);
        }
        if (typeof savedProfileDraft.bio === 'string') {
          setBio(savedProfileDraft.bio);
        }
      }
      setPortalHydrated(true);
    });
    return () => {
      active = false;
    };
  }, [portalFiltersStorageKey, profileDraftStorageKey, setupMode]);

  useEffect(() => {
    if (!portalHydrated) return;
    const url = new URL(window.location.href);
    if (tab !== 'assessments') url.searchParams.set('tab', tab);
    else url.searchParams.delete('tab');
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}`,
    );
  }, [portalHydrated, tab]);

  useEffect(() => {
    if (!portalHydrated) return;
    const isDefaultFilters =
      !showFilters &&
      statusFilter === 'all' &&
      companyFilter === 'all' &&
      roleFilter === 'all' &&
      sortBy === 'priority';
    if (isDefaultFilters) {
      removePersistedKey(portalFiltersStorageKey);
      return;
    }
    writePersistedJson(
      portalFiltersStorageKey,
      {
        showFilters,
        statusFilter,
        companyFilter,
        roleFilter,
        sortBy,
      },
      'session',
    );
  }, [
    companyFilter,
    portalFiltersStorageKey,
    portalHydrated,
    roleFilter,
    showFilters,
    sortBy,
    statusFilter,
  ]);

  useEffect(() => {
    if (!portalHydrated) return;
    const baselineHeadline =
      profile?.headlineRole || firstActionableAssessment?.targetRole || '';
    const baselineLevel =
      profile?.experienceLevel ||
      (firstActionableAssessment?.experienceLevel as ExperienceLevelId | '') ||
      '';
    const isDirty =
      fullName !== (profile?.fullName ?? '') ||
      phone !== (profile?.phone ?? '') ||
      locationCountry !== (profile?.locationCountry ?? '') ||
      locationCity !== (profile?.locationCity ?? '') ||
      workMode !== (profile?.workMode ?? 'any') ||
      headlineRole !== baselineHeadline ||
      yearsExperience !== (profile?.yearsExperience?.toString() ?? '') ||
      experienceLevel !== baselineLevel ||
      JSON.stringify(skills) !== JSON.stringify(profile?.skills ?? []) ||
      linkedinUrl !== (profile?.linkedinUrl ?? '') ||
      githubUrl !== (profile?.githubUrl ?? '') ||
      portfolioUrl !== (profile?.portfolioUrl ?? '') ||
      bio !== (profile?.bio ?? '');
    if (!isDirty) {
      removePersistedKey(profileDraftStorageKey);
      return;
    }
    writePersistedJson(
      profileDraftStorageKey,
      {
        fullName,
        phone,
        locationCountry,
        locationCity,
        workMode,
        headlineRole,
        yearsExperience,
        experienceLevel,
        skills,
        linkedinUrl,
        githubUrl,
        portfolioUrl,
        bio,
      },
      'durable',
    );
  }, [
    bio,
    experienceLevel,
    firstActionableAssessment?.experienceLevel,
    firstActionableAssessment?.targetRole,
    fullName,
    githubUrl,
    headlineRole,
    linkedinUrl,
    locationCity,
    locationCountry,
    phone,
    portalHydrated,
    portfolioUrl,
    profile,
    profileDraftStorageKey,
    skills,
    workMode,
    yearsExperience,
  ]);

  const [busy, setBusy] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const isQuickWelcome = Boolean(
    !profile?.profileCompletedAt && (setupMode || pendingLaunchSessionId),
  );

  const companies = useMemo(() => {
    return [
      ...new Map(
        assessments.map((a) => [a.organizationId, a.organizationName]),
      ),
    ];
  }, [assessments]);

  const roles = useMemo(() => {
    return [...new Set(assessments.map((a) => a.targetRole).filter(Boolean))];
  }, [assessments]);

  const filteredAssessments = useMemo(() => {
    const base = assessments.filter((a) => {
      if (statusFilter !== 'all' && a.pipelineStatus !== statusFilter) {
        return false;
      }
      if (companyFilter !== 'all' && a.organizationId !== companyFilter) {
        return false;
      }
      if (roleFilter !== 'all' && a.targetRole !== roleFilter) {
        return false;
      }
      return true;
    });
    const sorted = [...base];
    sorted.sort((a, b) => {
      if (sortBy === 'priority') {
        return compareAssessmentsByPriority(a, b);
      }
      if (sortBy === 'company') {
        return a.organizationName.localeCompare(b.organizationName);
      }
      if (sortBy === 'status') {
        return (
          candidateStageOrder[a.pipelineStatus] -
          candidateStageOrder[b.pipelineStatus]
        );
      }
      return b.createdAt.localeCompare(a.createdAt);
    });
    return sorted;
  }, [assessments, statusFilter, companyFilter, roleFilter, sortBy]);

  const toggleSkill = (skill: string) => {
    setSkills((prev) =>
      prev.includes(skill)
        ? prev.filter((item) => item !== skill)
        : prev.length >= 20
          ? prev
          : [...prev, skill],
    );
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setStatusMsg(null);
    setBusy('save');
    try {
      const csrf = readCsrfCookie();
      const resolvedYears = yearsExperience
        ? Number(yearsExperience)
        : (EXPERIENCE_LEVELS.find((lvl) => lvl.id === experienceLevel)
            ?.defaultYears ?? 3);
      const response = await fetch('/api/candidate-portal', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify({
          action: 'save_profile',
          csrf,
          fullName,
          phone,
          birthYear: initialProfile?.birthYear ?? null,
          locationCountry,
          locationCity,
          workMode,
          headlineRole,
          yearsExperience: resolvedYears,
          experienceLevel,
          skills,
          linkedinUrl,
          githubUrl,
          portfolioUrl,
          bio,
        }),
      });
      const data = (await response.json().catch(() => null)) as {
        profile?: CandidateProfile;
        error?: { message?: string };
      } | null;

      if (!response.ok || !data?.profile) {
        throw new Error(
          data?.error?.message ?? 'Unable to save candidate profile.',
        );
      }

      setProfile(data.profile);
      removePersistedKey(profileDraftStorageKey);

      setStatusMsg('Profile saved.');
      emitToast({ message: 'Profile saved.', tone: 'success' });
      const launchTarget =
        pendingLaunchSessionId ??
        (setupMode && nextPath ? (nextPath.split('/').at(-1) ?? '') : '');
      if (launchTarget) {
        await handleLaunchAssessment(launchTarget);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed.';
      setErrorMsg(msg);
      emitToast({ message: msg, tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const handleLaunchAssessment = async (sessionId: string) => {
    setErrorMsg(null);
    setBusy(`launch:${sessionId}`);
    try {
      const csrf = readCsrfCookie();
      const response = await fetch('/api/candidate-portal', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify({
          action: 'launch_session',
          csrf,
          sessionId,
        }),
      });
      const data = (await response.json().catch(() => null)) as {
        launchUrl?: string;
        error?: { code?: string; message?: string };
      } | null;

      if (!response.ok || !data?.launchUrl) {
        if (data?.error?.code === 'PROFILE_REQUIRED') {
          setPendingLaunchSessionId(sessionId);
          const matched = assessments.find((a) => a.sessionId === sessionId);
          if (!headlineRole && matched?.targetRole) {
            setHeadlineRole(matched.targetRole);
          }
          if (!experienceLevel && matched?.experienceLevel) {
            setExperienceLevel(matched.experienceLevel as ExperienceLevelId);
          }
          setTab('profile');
          setBusy(null);
          return;
        }
        throw new Error(
          data?.error?.message ?? 'Unable to launch assessment session.',
        );
      }
      window.location.assign(data.launchUrl);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Launch failed.');
      setBusy(null);
    }
  };

  const handleSignOut = async () => {
    await fetch('/api/candidate-portal', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'logout' }),
    }).catch(() => {});
    window.location.assign('/candidate/login');
  };

  return (
    <div className="hiring-candidate-portal software-product">
      <a className="software-skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="software-document-header hiring-portal-header">
        <div className="hiring-portal-brand">
          <a
            href="/candidate"
            className="software-document-wordmark"
            aria-label="Hirearchy Software assessments"
          >
            <span>Hirearchy</span>
            <span className="software-document-product">Software</span>
          </a>
        </div>
        <div className="hiring-header-actions">
          <span className="hiring-portal-email">{email}</span>

          <ThemeToggle variant="header" />
          <button
            type="button"
            className="hiring-btn hiring-btn-sm"
            onClick={() => void handleSignOut()}
          >
            <IconLogout size={14} aria-hidden="true" /> Sign out
          </button>
        </div>
      </header>

      <main
        className="hiring-portal-main software-portal-document"
        id="main-content"
        tabIndex={-1}
      >
        <div className="hiring-page-header">
          <div>
            <h1>{tab === 'assessments' ? 'My assessments' : 'My profile'}</h1>
            <p className="hiring-portal-mobile-email">Signed in as {email}</p>
          </div>
          {tab === 'assessments' && assessments.length >= 2 ? (
            <button
              type="button"
              className="hiring-btn hiring-btn-sm"
              aria-expanded={showFilters}
              onClick={() => setShowFilters((prev) => !prev)}
            >
              {showFilters ? 'Hide filters' : 'Filter & sort'}
            </button>
          ) : null}
        </div>
        {!profile?.profileCompletedAt &&
        assessments.some((item) => item.canLaunch) &&
        (setupMode || pendingLaunchSessionId || tab === 'profile') ? (
          <div className="hiring-banner hiring-banner-warning" role="status">
            <div>
              Confirm your details before opening your first assessment.
            </div>
          </div>
        ) : null}

        <HorizontalTabs<'assessments' | 'profile'>
          id="candidate-portal-tabs"
          label="Candidate sections"
          active={tab}
          onSelect={setTab}
          className="hiring-builder-tabs"
          tabClassName="hiring-builder-tab"
          tabs={[
            {
              id: 'assessments',
              label: (
                <>
                  <IconPlayerPlay size={16} aria-hidden="true" />
                  <span>Assessments</span>
                  <span
                    className="hiring-pill"
                    style={{
                      marginBlockStart: 0,
                      padding: '0.05rem 0.48rem',
                      fontSize: '0.72rem',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {assessments.length}
                  </span>
                </>
              ),
              ariaLabel: `Assessments (${assessments.length})`,
            },
            {
              id: 'profile',
              label: (
                <>
                  <IconUser size={16} aria-hidden="true" />
                  <span>Profile</span>
                  {profile?.profileCompletedAt ? (
                    <span
                      className="hiring-pill hiring-pill-success"
                      style={{
                        marginBlockStart: 0,
                        padding: '0.05rem 0.45rem',
                        fontSize: '0.7rem',
                      }}
                    >
                      <IconCheck size={11} stroke={2.4} aria-hidden="true" />
                      Complete
                    </span>
                  ) : (
                    <span
                      className="hiring-pill hiring-pill-warning"
                      style={{
                        marginBlockStart: 0,
                        padding: '0.05rem 0.45rem',
                        fontSize: '0.7rem',
                      }}
                    >
                      Setup needed
                    </span>
                  )}
                </>
              ),
              ariaLabel: profile?.profileCompletedAt
                ? 'Profile (Complete)'
                : 'Profile (Setup needed)',
            },
          ]}
        />

        {errorMsg ? (
          <div className="hiring-banner hiring-banner-danger" role="alert">
            {errorMsg}
          </div>
        ) : null}
        {statusMsg ? (
          <div className="hiring-banner hiring-banner-success" role="status">
            <span>{statusMsg}</span>
            {statusMsg === 'Profile saved.' && !setupMode ? (
              <button
                type="button"
                className="hiring-btn hiring-btn-sm hiring-btn-mint"
                onClick={() => setTab('assessments')}
              >
                Back to assessments
              </button>
            ) : null}
          </div>
        ) : null}

        <div
          id="candidate-portal-tabs-panel"
          role="tabpanel"
          aria-labelledby={`candidate-portal-tabs-${tab}`}
          className="ct-enter-crossfade"
          key={tab}
        >
          {tab === 'assessments' ? (
            <div
              className={
                showFilters && assessments.length >= 2
                  ? 'software-directory'
                  : 'hiring-page-shell'
              }
            >
              {showFilters && assessments.length >= 2 ? (
                <section
                  className="hiring-filter-bar"
                  aria-label="Filter your assessments"
                >
                  <div className="hiring-filter-grid">
                    <div className="hiring-field">
                      <label htmlFor="portal-status">Status</label>
                      <select
                        id="portal-status"
                        value={statusFilter}
                        onChange={(e) =>
                          setStatusFilter(e.target.value as PipelineStatusId)
                        }
                      >
                        {Object.entries(candidateStatusLabels)
                          .filter(([id]) => id !== 'second_opinion')
                          .map(([id, label]) => (
                            <option key={id} value={id}>
                              {label}
                            </option>
                          ))}
                      </select>
                    </div>

                    <div className="hiring-field">
                      <label htmlFor="portal-company">Company</label>
                      <select
                        id="portal-company"
                        value={companyFilter}
                        onChange={(e) => setCompanyFilter(e.target.value)}
                      >
                        <option value="all">All companies</option>
                        {companies.map(([id, name]) => (
                          <option key={id} value={id}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="hiring-field">
                      <label htmlFor="portal-role">Position</label>
                      <select
                        id="portal-role"
                        value={roleFilter}
                        onChange={(e) => setRoleFilter(e.target.value)}
                      >
                        <option value="all">All roles</option>
                        {roles.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="hiring-field">
                      <label htmlFor="portal-sort">Sort by</label>
                      <select
                        id="portal-sort"
                        value={sortBy}
                        onChange={(e) =>
                          setSortBy(
                            e.target.value as
                              'priority' | 'recent' | 'company' | 'status',
                          )
                        }
                      >
                        <option value="priority">Action needed first</option>
                        <option value="recent">Newest issued</option>
                        <option value="company">Company name</option>
                        <option value="status">Assessment stage</option>
                      </select>
                    </div>
                  </div>
                </section>
              ) : null}

              <section
                className="software-directory-results"
                aria-label="Assessment results"
              >
                {filteredAssessments.length === 0 ? (
                  <div className="hiring-card">
                    <h2>
                      {assessments.length
                        ? 'No assessments match these filters'
                        : 'No invitations for this account'}
                    </h2>
                    <p>
                      {assessments.length
                        ? 'Choose another status, company, or role.'
                        : `No candidate invitations were found for ${email}. If your invitation was sent to another address, switch to your invited email.`}
                    </p>
                    {!assessments.length ? (
                      <div className="hiring-header-actions hiring-mt-sm">
                        <button
                          type="button"
                          className="hiring-btn hiring-btn-primary"
                          onClick={() => void handleSignOut()}
                        >
                          Switch to your invited email
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="hiring-candidate-list">
                    {filteredAssessments.map((item) => {
                      const isActionableActive =
                        item.canLaunch && item.status === 'ACTIVE';
                      const isActionableCreated =
                        item.canLaunch && item.status === 'CREATED';
                      const expiryCountdown =
                        item.status === 'CREATED' && item.invitationExpiresAt
                          ? formatExpiresCountdown(item.invitationExpiresAt)
                          : null;
                      const cardStyle: CSSProperties | undefined =
                        isActionableActive
                          ? {
                              borderInlineStart:
                                '3px solid var(--software-mint)',
                            }
                          : isActionableCreated
                            ? {
                                borderInlineStart:
                                  '3px solid color-mix(in srgb, var(--software-plum) 60%, #8b6bb5 40%)',
                              }
                            : undefined;

                      return (
                        <article
                          key={item.sessionId}
                          className={`hiring-card hiring-card-animated${item.canLaunch ? ' ct-card-interactive' : ''}`}
                          style={cardStyle}
                        >
                          <div className="hiring-portal-card-head">
                            <div>
                              <div className="hiring-candidate-name">
                                <span className="hiring-eyebrow">
                                  {item.organizationName}
                                </span>
                                <span
                                  className={portalStatusBadgeClass(
                                    item.pipelineStatus,
                                  )}
                                >
                                  {candidateStatusLabels[item.pipelineStatus]}
                                </span>
                                {isActionableActive ? (
                                  <span
                                    className="hiring-pill hiring-pill-mint"
                                    style={{ marginBlockStart: 0 }}
                                  >
                                    Resume workspace →
                                  </span>
                                ) : isActionableCreated && expiryCountdown ? (
                                  <span
                                    suppressHydrationWarning
                                    className={`hiring-pill ${expiryCountdown.urgent ? 'hiring-pill-warning' : 'hiring-pill-plum'}`}
                                    style={{
                                      marginBlockStart: 0,
                                      fontVariantNumeric: 'tabular-nums',
                                    }}
                                    title={formatLocalDateTime(
                                      item.invitationExpiresAt,
                                    )}
                                  >
                                    <IconClock
                                      size={12}
                                      stroke={2}
                                      aria-hidden="true"
                                    />
                                    {expiryCountdown.label}
                                  </span>
                                ) : null}
                              </div>
                              <h2 className="hiring-portal-card-title">
                                {item.scenarioTitle}
                              </h2>
                              <div className="hiring-candidate-meta">
                                <span>{item.targetRole}</span>
                                <span>
                                  {experienceLevelLabel(item.experienceLevel)}
                                </span>
                                <span>
                                  {item.durationSeconds
                                    ? `${Math.round(item.durationSeconds / 60)} min`
                                    : 'Untimed'}
                                </span>
                                {item.status === 'CREATED' &&
                                item.invitationExpiresAt ? (
                                  <span>
                                    Expires{' '}
                                    <LocalTime
                                      timestamp={item.invitationExpiresAt}
                                      absolute
                                    />
                                  </span>
                                ) : null}
                                {item.submittedAt ? (
                                  <span
                                    title={formatLocalDateTime(
                                      item.submittedAt,
                                    )}
                                  >
                                    Submitted{' '}
                                    {formatRelativeTime(item.submittedAt)}
                                  </span>
                                ) : null}
                              </div>
                            </div>

                            {item.canLaunch ? (
                              <button
                                type="button"
                                className="hiring-btn hiring-btn-primary hiring-portal-card-cta"
                                disabled={busy !== null}
                                onClick={() =>
                                  void handleLaunchAssessment(item.sessionId)
                                }
                              >
                                <IconPlayerPlay size={15} />{' '}
                                {busy === `launch:${item.sessionId}`
                                  ? 'Launching…'
                                  : item.status === 'ACTIVE'
                                    ? 'Continue assessment'
                                    : 'Open assessment'}
                              </button>
                            ) : item.status === 'SUBMITTED' ? (
                              <Link
                                className="hiring-btn hiring-portal-card-cta"
                                href={`/candidate/submissions/${encodeURIComponent(item.sessionId)}`}
                                prefetch={false}
                              >
                                View submitted work
                              </Link>
                            ) : null}
                          </div>

                          {item.publishedOutcome ? (
                            <CandidateOutcome outcome={item.publishedOutcome} />
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          ) : (
            <form
              onSubmit={handleSaveProfile}
              className="hiring-card hiring-card-animated hiring-page-shell"
            >
              <div>
                <h2>
                  {isQuickWelcome
                    ? 'Confirm your details'
                    : 'Professional details'}
                </h2>
                <p className="hiring-muted-copy hiring-mt-xs">
                  {isQuickWelcome
                    ? 'Confirm your name to begin. Role and level are prefilled from your invitation—you can add optional skills and links later.'
                    : 'Your hiring teams can see the experience, skills, and links you add.'}
                </p>
              </div>

              <div className="hiring-two-col">
                <div className="hiring-field">
                  <label htmlFor="prof-name">Full name</label>
                  <input
                    id="prof-name"
                    type="text"
                    autoComplete="name"
                    required
                    minLength={2}
                    maxLength={120}
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Your full name"
                  />
                </div>

                <div className="hiring-field">
                  <label htmlFor="prof-role">Primary engineering role</label>
                  <select
                    id="prof-role"
                    required
                    value={headlineRole}
                    onChange={(e) => setHeadlineRole(e.target.value)}
                  >
                    <option value="">Choose a role</option>
                    {HIRING_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="hiring-field">
                  <label htmlFor="prof-level">Seniority level</label>
                  <select
                    id="prof-level"
                    required
                    value={experienceLevel}
                    onChange={(e) => {
                      const nextLevel = e.target.value as
                        ExperienceLevelId | '';
                      setExperienceLevel(nextLevel);
                      if (!yearsExperience && nextLevel) {
                        const defYears = EXPERIENCE_LEVELS.find(
                          (lvl) => lvl.id === nextLevel,
                        )?.defaultYears;
                        if (defYears !== undefined) {
                          setYearsExperience(String(defYears));
                        }
                      }
                    }}
                  >
                    <option value="">Choose an experience level</option>
                    {EXPERIENCE_LEVELS.map((lvl) => (
                      <option key={lvl.id} value={lvl.id}>
                        {lvl.label}
                      </option>
                    ))}
                  </select>
                </div>

                {!isQuickWelcome ? (
                  <div className="hiring-field">
                    <label htmlFor="prof-years">Years of experience</label>
                    <select
                      id="prof-years"
                      required
                      value={yearsExperience}
                      onChange={(e) => setYearsExperience(e.target.value)}
                    >
                      <option value="">Choose years of experience</option>
                      {YEARS_EXPERIENCE_OPTIONS.map((y) => (
                        <option key={y.value} value={y.value}>
                          {y.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </div>

              {!isQuickWelcome ? (
                <>
                  <div className="hiring-card-subtle">
                    <strong>Connected email</strong>
                    <p className="hiring-muted-copy hiring-mt-xs">
                      Signed in as <strong>{email}</strong>. Invitations sent to
                      this address appear in your portal.
                      {profile?.candidateCode ? (
                        <>
                          {' '}
                          Candidate ID: <code>{profile.candidateCode}</code>.
                        </>
                      ) : null}
                    </p>
                  </div>

                  <div className="hiring-field">
                    <span className="hiring-field-label">Core skills</span>
                    <div className="hiring-chip-group">
                      {CURATED_SKILLS.map((skill) => {
                        const active = skills.includes(skill);
                        return (
                          <button
                            key={skill}
                            type="button"
                            className={`hiring-chip${active ? ' is-active' : ''}`}
                            onClick={() => toggleSkill(skill)}
                            aria-pressed={active}
                          >
                            {active ? (
                              <IconCheck
                                size={13}
                                stroke={2.4}
                                aria-hidden="true"
                              />
                            ) : null}
                            {skill}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <details
                    className="hiring-card-subtle"
                    open={Boolean(
                      phone ||
                      locationCountry ||
                      locationCity ||
                      githubUrl ||
                      linkedinUrl ||
                      portfolioUrl ||
                      bio,
                    )}
                  >
                    <summary style={{ cursor: 'pointer', fontWeight: 650 }}>
                      Optional details (location, links &amp; bio)
                    </summary>
                    <div className="hiring-stack-sm hiring-mt-sm">
                      <div className="hiring-two-col">
                        <div className="hiring-field">
                          <label htmlFor="prof-phone">Phone number</label>
                          <input
                            id="prof-phone"
                            type="tel"
                            maxLength={40}
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                            placeholder="+20 100 000 0000"
                          />
                        </div>

                        <div className="hiring-field">
                          <label htmlFor="prof-country">Country / region</label>
                          <select
                            id="prof-country"
                            value={locationCountry}
                            onChange={(e) => setLocationCountry(e.target.value)}
                          >
                            <option value="">Choose a country or region</option>
                            {CURATED_COUNTRIES.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="hiring-field">
                          <label htmlFor="prof-city">City</label>
                          <input
                            id="prof-city"
                            type="text"
                            maxLength={100}
                            value={locationCity}
                            onChange={(e) => setLocationCity(e.target.value)}
                            placeholder="Cairo"
                          />
                        </div>

                        <div className="hiring-field">
                          <label htmlFor="prof-workmode">
                            Preferred work mode
                          </label>
                          <select
                            id="prof-workmode"
                            value={workMode}
                            onChange={(e) =>
                              setWorkMode(e.target.value as WorkModeId)
                            }
                          >
                            {WORK_MODES.map((wm) => (
                              <option key={wm.id} value={wm.id}>
                                {wm.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="hiring-filter-grid">
                        <div className="hiring-field">
                          <label htmlFor="prof-github">GitHub URL</label>
                          <input
                            id="prof-github"
                            type="url"
                            maxLength={300}
                            value={githubUrl}
                            onChange={(e) => setGithubUrl(e.target.value)}
                            placeholder="https://github.com/username"
                          />
                        </div>
                        <div className="hiring-field">
                          <label htmlFor="prof-linkedin">LinkedIn URL</label>
                          <input
                            id="prof-linkedin"
                            type="url"
                            maxLength={300}
                            value={linkedinUrl}
                            onChange={(e) => setLinkedinUrl(e.target.value)}
                            placeholder="https://linkedin.com/in/username"
                          />
                        </div>
                        <div className="hiring-field">
                          <label htmlFor="prof-portfolio">
                            Portfolio / site
                          </label>
                          <input
                            id="prof-portfolio"
                            type="url"
                            maxLength={300}
                            value={portfolioUrl}
                            onChange={(e) => setPortfolioUrl(e.target.value)}
                            placeholder="https://example.dev"
                          />
                        </div>
                      </div>

                      <div className="hiring-field">
                        <div className="software-field-heading">
                          <label htmlFor="prof-bio">
                            Short engineering bio
                          </label>
                        </div>
                        <textarea
                          id="prof-bio"
                          maxLength={2000}
                          value={bio}
                          onChange={(e) => setBio(e.target.value)}
                          placeholder="Brief background on systems, backend APIs, or frontend architecture you have shipped."
                        />
                      </div>
                    </div>
                  </details>
                </>
              ) : null}

              <div className="hiring-header-actions">
                <button
                  type="submit"
                  className="hiring-btn hiring-btn-primary"
                  disabled={busy !== null}
                >
                  {busy === 'save'
                    ? 'Saving…'
                    : setupMode && nextPath
                      ? 'Save & open assessment'
                      : 'Save profile'}
                </button>
              </div>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
