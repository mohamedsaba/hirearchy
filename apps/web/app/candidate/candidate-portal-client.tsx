'use client';

import { useMemo, useState } from 'react';
import {
  IconCheck,
  IconLogout,
  IconPlayerPlay,
  IconShieldCheck,
  IconUser,
} from '@tabler/icons-react';

import {
  CURATED_COUNTRIES,
  CURATED_SKILLS,
  EXPERIENCE_LEVELS,
  HIRING_ROLES,
  ID_DOCUMENT_TYPES,
  PIPELINE_STATUS_OPTIONS,
  WORK_MODES,
  YEARS_EXPERIENCE_OPTIONS,
  computeAgeFromBirthYear,
  experienceLevelLabel,
  type ExperienceLevelId,
  type IdDocumentTypeId,
  type PipelineStatusId,
  type WorkModeId,
} from '../../src/hiring/catalogs';
import type {
  CandidateProfile,
  SafePortalAssessmentView,
} from '../../src/hiring/types';
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

function portalStatusLabel(status: PipelineStatusId): string {
  return (
    PIPELINE_STATUS_OPTIONS.find((opt) => opt.id === status)?.label ?? status
  );
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
  const [tab, setTab] = useState<'assessments' | 'profile'>(
    setupMode || !initialProfile?.profileCompletedAt
      ? 'profile'
      : 'assessments',
  );

  // Filters on Assessments tab
  const [statusFilter, setStatusFilter] = useState<PipelineStatusId>('all');
  const [companyFilter, setCompanyFilter] = useState('all');
  const [roleFilter, setRoleFilter] = useState('all');
  const [sortBy, setSortBy] = useState<'recent' | 'company' | 'status'>(
    'recent',
  );

  // Editable Profile fields
  const [fullName, setFullName] = useState(initialProfile?.fullName ?? '');
  const [phone, setPhone] = useState(initialProfile?.phone ?? '');
  const [birthYear, setBirthYear] = useState<string>(
    initialProfile?.birthYear ? String(initialProfile.birthYear) : '',
  );
  const [locationCountry, setLocationCountry] = useState(
    initialProfile?.locationCountry ?? CURATED_COUNTRIES[0],
  );
  const [locationCity, setLocationCity] = useState(
    initialProfile?.locationCity ?? '',
  );
  const [workMode, setWorkMode] = useState<WorkModeId>(
    initialProfile?.workMode ?? 'remote',
  );
  const [headlineRole, setHeadlineRole] = useState(
    initialProfile?.headlineRole ?? HIRING_ROLES[0],
  );
  const [yearsExperience, setYearsExperience] = useState<number>(
    initialProfile?.yearsExperience ?? 3,
  );
  const [experienceLevel, setExperienceLevel] = useState<ExperienceLevelId>(
    initialProfile?.experienceLevel ?? 'mid',
  );
  const [skills, setSkills] = useState<string[]>(
    initialProfile?.skills ? [...initialProfile.skills] : ['Python', 'SQL'],
  );
  const [idDocumentType, setIdDocumentType] = useState<IdDocumentTypeId>(
    initialProfile?.idDocumentType ?? 'national_id',
  );
  const [idDocumentNumber, setIdDocumentNumber] = useState('');
  const [linkedinUrl, setLinkedinUrl] = useState(
    initialProfile?.linkedinUrl ?? '',
  );
  const [githubUrl, setGithubUrl] = useState(initialProfile?.githubUrl ?? '');
  const [portfolioUrl, setPortfolioUrl] = useState(
    initialProfile?.portfolioUrl ?? '',
  );
  const [bio, setBio] = useState(initialProfile?.bio ?? '');

  const [busy, setBusy] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const companies = useMemo(() => {
    return [...new Set(assessments.map((a) => a.organizationName))];
  }, [assessments]);

  const roles = useMemo(() => {
    return [...new Set(assessments.map((a) => a.targetRole).filter(Boolean))];
  }, [assessments]);

  const filteredAssessments = useMemo(() => {
    const base = assessments.filter((a) => {
      if (statusFilter !== 'all' && a.pipelineStatus !== statusFilter) {
        return false;
      }
      if (companyFilter !== 'all' && a.organizationName !== companyFilter) {
        return false;
      }
      if (roleFilter !== 'all' && a.targetRole !== roleFilter) {
        return false;
      }
      return true;
    });
    const sorted = [...base];
    sorted.sort((a, b) => {
      if (sortBy === 'company') {
        return a.organizationName.localeCompare(b.organizationName);
      }
      if (sortBy === 'status') {
        return a.pipelineStatus.localeCompare(b.pipelineStatus);
      }
      return b.createdAt.localeCompare(a.createdAt);
    });
    return sorted;
  }, [assessments, statusFilter, companyFilter, roleFilter, sortBy]);

  const computedAge = useMemo(() => {
    const parsed = Number(birthYear);
    return birthYear && Number.isFinite(parsed)
      ? computeAgeFromBirthYear(Math.trunc(parsed))
      : null;
  }, [birthYear]);

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
          birthYear: birthYear ? Number(birthYear) : null,
          locationCountry,
          locationCity,
          workMode,
          headlineRole,
          yearsExperience,
          experienceLevel,
          skills,
          idDocumentType,
          idDocumentNumber,
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
      setIdDocumentNumber('');
      setStatusMsg(
        'Candidate profile and identity details saved across Hirearchy.',
      );
      if (setupMode && nextPath) {
        window.location.assign(nextPath);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Save failed.');
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
          setTab('profile');
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
      <header className="hiring-portal-header">
        <div className="hiring-portal-brand">
          <strong>Hirearchy</strong>
          <span className="software-product-capsule">Software</span>
          <span className="hiring-pill">Candidate Portal</span>
          {profile?.candidateCode ? (
            <span className="hiring-pill hiring-pill-plum">
              {profile.candidateCode}
            </span>
          ) : null}
        </div>
        <div className="hiring-header-actions">
          <span className="hiring-portal-email">{email}</span>
          <ThemeToggle variant="header" />
          <button
            type="button"
            className="hiring-btn hiring-btn-sm"
            onClick={() => void handleSignOut()}
          >
            <IconLogout size={14} /> Sign out
          </button>
        </div>
      </header>

      <main className="hiring-portal-main">
        {setupMode || !profile?.profileCompletedAt ? (
          <div className="hiring-banner hiring-banner-warning" role="status">
            <div>
              <strong>Complete your candidate profile first:</strong> Companies
              use your verified identity details (name, birth year, location,
              experience, and ID verification) before unlocking assessment
              workspaces.
            </div>
          </div>
        ) : null}

        <div
          className="hiring-builder-tabs"
          role="tablist"
          aria-label="Candidate sections"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'assessments'}
            className={`hiring-builder-tab${tab === 'assessments' ? ' is-active' : ''}`}
            onClick={() => setTab('assessments')}
          >
            <IconPlayerPlay size={16} /> My Assessments ({assessments.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'profile'}
            className={`hiring-builder-tab${tab === 'profile' ? ' is-active' : ''}`}
            onClick={() => setTab('profile')}
          >
            <IconUser size={16} /> My Profile &amp; Identity Verification
          </button>
        </div>

        {errorMsg ? (
          <div className="hiring-banner hiring-banner-danger" role="alert">
            {errorMsg}
          </div>
        ) : null}
        {statusMsg ? (
          <div className="hiring-banner hiring-banner-success" role="status">
            {statusMsg}
          </div>
        ) : null}

        {tab === 'assessments' ? (
          <div className="hiring-page-shell">
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
                    {PIPELINE_STATUS_OPTIONS.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.label}
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
                    {companies.map((c) => (
                      <option key={c} value={c}>
                        {c}
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
                        e.target.value as 'recent' | 'company' | 'status',
                      )
                    }
                  >
                    <option value="recent">Newest issued</option>
                    <option value="company">Company name</option>
                    <option value="status">Assessment stage</option>
                  </select>
                </div>
              </div>
            </section>

            {filteredAssessments.length === 0 ? (
              <div className="hiring-card">
                <h2>No assessments issued to {email} yet</h2>
                <p>
                  When any hiring organization issues an assessment to your
                  email address, it will appear here alongside published
                  feedback and next steps.
                </p>
              </div>
            ) : (
              <div className="hiring-candidate-list">
                {filteredAssessments.map((item) => (
                  <article
                    key={item.sessionId}
                    className="hiring-card hiring-card-animated"
                  >
                    <div className="hiring-portal-card-head">
                      <div>
                        <div className="hiring-candidate-name">
                          <span className="hiring-pill hiring-pill-plum">
                            {item.organizationName}
                          </span>
                          <span
                            className={portalStatusBadgeClass(
                              item.pipelineStatus,
                            )}
                          >
                            {portalStatusLabel(item.pipelineStatus)}
                          </span>
                        </div>
                        <h2 className="hiring-portal-card-title">
                          {item.scenarioTitle}
                        </h2>
                        <div className="hiring-candidate-meta">
                          <span>Role: {item.targetRole}</span>
                          <span>
                            Level: {experienceLevelLabel(item.experienceLevel)}
                          </span>
                          <span>
                            Time limit:{' '}
                            {item.durationSeconds
                              ? `${Math.round(item.durationSeconds / 60)} min`
                              : 'Untimed'}
                          </span>
                        </div>
                      </div>

                      {item.canLaunch ? (
                        <button
                          type="button"
                          className="hiring-btn hiring-btn-primary"
                          disabled={busy !== null}
                          onClick={() =>
                            void handleLaunchAssessment(item.sessionId)
                          }
                        >
                          <IconPlayerPlay size={15} />{' '}
                          {busy === `launch:${item.sessionId}`
                            ? 'Launching...'
                            : item.status === 'ACTIVE'
                              ? 'Resume Assessment'
                              : 'Start Assessment'}
                        </button>
                      ) : item.status === 'SUBMITTED' ? (
                        <span className="hiring-pill hiring-pill-success">
                          <IconCheck size={13} /> Submitted
                        </span>
                      ) : (
                        <span className="hiring-pill hiring-pill-danger">
                          Invitation inactive or expired
                        </span>
                      )}
                    </div>

                    {item.publishedOutcome ? (
                      <div className="hiring-outcome-box hiring-mt-md">
                        <div className="hiring-candidate-name">
                          <strong>
                            {item.publishedOutcome.decision === 'accepted'
                              ? `Moved Forward: ${item.publishedOutcome.nextStageLabel ?? 'Next Stage'}`
                              : 'Evaluation Outcome & Feedback'}
                          </strong>
                          <span
                            className={`hiring-pill ${item.publishedOutcome.decision === 'accepted' ? 'hiring-pill-success' : 'hiring-pill-danger'}`}
                          >
                            {item.publishedOutcome.decision}
                          </span>
                        </div>

                        {item.publishedOutcome.feedbackNote ? (
                          <p className="hiring-outcome-note">
                            {item.publishedOutcome.feedbackNote}
                          </p>
                        ) : null}

                        <div className="hiring-two-col">
                          {item.publishedOutcome.strengths.length > 0 ? (
                            <div>
                              <strong>Strengths noted</strong>
                              <ul className="hiring-bullet-list">
                                {item.publishedOutcome.strengths.map((s, i) => (
                                  <li key={i}>{s}</li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                          {item.publishedOutcome.weaknesses.length > 0 ? (
                            <div>
                              <strong>Areas for growth</strong>
                              <ul className="hiring-bullet-list">
                                {item.publishedOutcome.weaknesses.map(
                                  (w, i) => (
                                    <li key={i}>{w}</li>
                                  ),
                                )}
                              </ul>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </div>
        ) : (
          <form
            onSubmit={handleSaveProfile}
            className="hiring-card hiring-card-animated hiring-page-shell"
          >
            <div>
              <span className="hiring-eyebrow">
                Verified Candidate Identity
              </span>
              <h2>Profile &amp; Legitimacy Details</h2>
              <p className="hiring-muted-copy hiring-mt-xs">
                Complete these details once. Every hiring team assessing your
                submissions can verify your identity and filter cleanly by
                experience, skills, and location.
              </p>
            </div>

            <div className="hiring-two-col">
              <div className="hiring-field">
                <label htmlFor="prof-name">Full legal name</label>
                <input
                  id="prof-name"
                  type="text"
                  required
                  minLength={2}
                  maxLength={120}
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Your full name"
                />
              </div>

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
                <label htmlFor="prof-birthyear">
                  Birth year{' '}
                  {computedAge !== null ? `(Age ${computedAge})` : ''}
                </label>
                <input
                  id="prof-birthyear"
                  type="number"
                  required
                  min={1940}
                  max={2012}
                  value={birthYear}
                  onChange={(e) => setBirthYear(e.target.value)}
                  placeholder="1997"
                />
              </div>

              <div className="hiring-field">
                <label htmlFor="prof-country">Country / region</label>
                <select
                  id="prof-country"
                  value={locationCountry}
                  onChange={(e) => setLocationCountry(e.target.value)}
                >
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
                <label htmlFor="prof-workmode">Preferred work mode</label>
                <select
                  id="prof-workmode"
                  value={workMode}
                  onChange={(e) => setWorkMode(e.target.value as WorkModeId)}
                >
                  {WORK_MODES.map((wm) => (
                    <option key={wm.id} value={wm.id}>
                      {wm.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="hiring-field">
                <label htmlFor="prof-role">Primary engineering role</label>
                <select
                  id="prof-role"
                  value={headlineRole}
                  onChange={(e) => setHeadlineRole(e.target.value)}
                >
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
                  value={experienceLevel}
                  onChange={(e) =>
                    setExperienceLevel(e.target.value as ExperienceLevelId)
                  }
                >
                  {EXPERIENCE_LEVELS.map((lvl) => (
                    <option key={lvl.id} value={lvl.id}>
                      {lvl.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="hiring-field">
                <label htmlFor="prof-years">Years of experience</label>
                <select
                  id="prof-years"
                  value={yearsExperience}
                  onChange={(e) => setYearsExperience(Number(e.target.value))}
                >
                  {YEARS_EXPERIENCE_OPTIONS.map((y) => (
                    <option key={y.value} value={y.value}>
                      {y.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="hiring-card-subtle">
              <div className="hiring-candidate-name">
                <IconShieldCheck size={16} />
                <strong>Identity Document Verification (Masked Storage)</strong>
                {profile?.idVerificationStatus &&
                profile.idVerificationStatus !== 'unsubmitted' ? (
                  <span className="hiring-pill hiring-pill-success">
                    {profile.idVerificationStatus} ({profile.idDocumentMasked})
                  </span>
                ) : null}
              </div>
              <p className="hiring-muted-copy hiring-mt-xs">
                Only the masked last 4 digits and verification status are stored
                so hiring teams can confirm candidate authenticity safely.
              </p>
              <div className="hiring-two-col hiring-mt-sm">
                <div className="hiring-field">
                  <label htmlFor="prof-id-type">Document type</label>
                  <select
                    id="prof-id-type"
                    value={idDocumentType}
                    onChange={(e) =>
                      setIdDocumentType(e.target.value as IdDocumentTypeId)
                    }
                  >
                    {ID_DOCUMENT_TYPES.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="hiring-field">
                  <label htmlFor="prof-id-num">
                    ID / Passport number{' '}
                    {profile?.idDocumentMasked
                      ? `(currently ${profile.idDocumentMasked})`
                      : ''}
                  </label>
                  <input
                    id="prof-id-num"
                    type="text"
                    maxLength={40}
                    required={!profile?.idDocumentMasked}
                    value={idDocumentNumber}
                    onChange={(e) => setIdDocumentNumber(e.target.value)}
                    placeholder="Enter ID / Passport reference"
                  />
                </div>
              </div>
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
                      {skill}
                    </button>
                  );
                })}
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
                <label htmlFor="prof-portfolio">Portfolio / site</label>
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
              <label htmlFor="prof-bio">Short engineering bio</label>
              <textarea
                id="prof-bio"
                maxLength={2000}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Brief background on distributed systems, backend APIs, or frontend architecture you have shipped."
              />
            </div>

            <div className="hiring-header-actions">
              <button
                type="submit"
                className="hiring-btn hiring-btn-primary"
                disabled={busy !== null}
              >
                {busy === 'save'
                  ? 'Saving profile...'
                  : setupMode && nextPath
                    ? 'Save Profile & Continue to Assessment →'
                    : 'Save Candidate Profile'}
              </button>
            </div>
          </form>
        )}
      </main>
    </div>
  );
}
