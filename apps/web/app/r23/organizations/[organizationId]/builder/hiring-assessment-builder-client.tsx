'use client';

import { useMemo, useState } from 'react';
import {
  IconBookmark,
  IconCheck,
  IconCopy,
  IconFileCode,
  IconSend,
  IconSparkles,
  IconTemplate,
} from '@tabler/icons-react';

import {
  CURATED_SKILLS,
  DOMAIN_OPTIONS,
  EXPERIENCE_LEVELS,
  HIRING_ROLES,
  INVITATION_EXPIRY_OPTIONS,
  PROBLEM_STRUCTURE_OPTIONS,
  WORK_KIND_OPTIONS,
  YEARS_EXPERIENCE_OPTIONS,
  experienceLevelLabel,
  type ExperienceLevelId,
  type ProblemStructureId,
} from '../../../../../src/hiring/catalogs';
import type {
  PlatformTemplateView,
  SavedLibraryProblem,
  TeamMemberOption,
} from '../../../../../src/hiring/types';
import {
  formatPlanBadge,
  hasPlanFeature,
  type OrganizationPlanSummary,
} from '../../../../../src/plans/entitlements';
import type { R211AssessmentDraftInput } from '../../../../../src/r211-builder/contract';

export interface HiringAssessmentBuilderClientProps {
  readonly organizationId: string;
  readonly currentPrincipalId: string;
  readonly initialPlan: OrganizationPlanSummary;
  readonly initialLibrary: readonly SavedLibraryProblem[];
  readonly initialTemplates: readonly PlatformTemplateView[];
  readonly teamMembers: readonly TeamMemberOption[];
}

type BuilderMode = 'templates' | 'ai' | 'library';

function readCsrfCookie(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)__Host-r23-csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function toDraftInput(problem: SavedLibraryProblem): R211AssessmentDraftInput {
  return {
    templateId:
      problem.templateId === 'reservation-moves-v3' ||
      problem.templateId === 'webhook-dedup-v1' ||
      problem.templateId === 'cache-rate-limiter-v1'
        ? problem.templateId
        : 'ai-generated',
    title: problem.title,
    brief: problem.brief,
    expectedBehavior: problem.expectedBehavior,
    acceptanceCriteria: problem.acceptanceCriteria,
    primaryFilePath: problem.primaryFilePath,
    starterFiles: problem.starterFiles,
    durationMinutes: problem.durationMinutes,
    terminalEnabled: problem.terminalEnabled,
    integratedAi: problem.integratedAi,
    rubric: problem.rubric.map((r) => ({
      id: r.id,
      label: r.label,
      description: r.description,
      weight: r.weight,
      applicability: {
        kind:
          r.applicability.kind === 'recorded_integrated_ai_interaction'
            ? 'recorded_integrated_ai_interaction'
            : 'always',
        rule: r.applicability.rule,
      },
    })),
  };
}

export function HiringAssessmentBuilderClient({
  organizationId,
  currentPrincipalId,
  initialPlan,
  initialLibrary,
  initialTemplates,
  teamMembers,
}: HiringAssessmentBuilderClientProps) {
  const [plan, setPlan] = useState<OrganizationPlanSummary>(initialPlan);
  const [library, setLibrary] =
    useState<readonly SavedLibraryProblem[]>(initialLibrary);
  const [mode, setMode] = useState<BuilderMode>('templates');

  // Active preview problem state
  const defaultTemplate = initialTemplates[0];
  const [activeDraft, setActiveDraft] = useState<R211AssessmentDraftInput>(
    () => ({
      ...defaultTemplate.baseDraft,
      durationMinutes: 60,
      integratedAi: false,
    }),
  );
  const [activeSourceMeta, setActiveSourceMeta] = useState<{
    sourceKind: 'template' | 'ai_generated';
    targetRole: string;
    experienceLevel: ExperienceLevelId;
    yearsExperience: number;
    skills: readonly string[];
    problemStructure: ProblemStructureId;
    workKind: string;
    domain: string;
    generationBrief?: Record<string, unknown>;
  }>({
    sourceKind: 'template',
    targetRole: defaultTemplate.targetRole,
    experienceLevel: defaultTemplate.experienceLevel,
    yearsExperience: defaultTemplate.yearsExperience,
    skills: defaultTemplate.skills,
    problemStructure: defaultTemplate.problemStructure,
    workKind: defaultTemplate.workKind,
    domain: defaultTemplate.domain,
  });
  const [savedIds, setSavedIds] = useState<{
    definitionId: string;
    validatedVersionId: string;
  } | null>(null);
  const [previewFilePath, setPreviewFilePath] = useState<string>(
    defaultTemplate.baseDraft.primaryFilePath,
  );

  // Template tab options
  const [tplDuration, setTplDuration] = useState<30 | 45 | 60 | 90>(60);
  const [tplIntegratedAi, setTplIntegratedAi] = useState(false);

  // AI Generator state
  const [aiRole, setAiRole] = useState<string>(HIRING_ROLES[0]);
  const [aiExpLevel, setAiExpLevel] = useState<ExperienceLevelId>('mid');
  const [aiYears, setAiYears] = useState<number>(3);
  const [aiSkills, setAiSkills] = useState<string[]>([
    'Python',
    'Concurrency & Idempotency',
    'Testing & Debugging',
  ]);
  const [aiStructure, setAiStructure] =
    useState<ProblemStructureId>('multi_file');
  const [aiWorkKind, setAiWorkKind] = useState<string>(WORK_KIND_OPTIONS[0].id);
  const [aiDomain, setAiDomain] = useState<string>(DOMAIN_OPTIONS[0].id);
  const [aiDuration, setAiDuration] = useState<30 | 45 | 60 | 90>(60);
  const [aiIntegratedAi, setAiIntegratedAi] = useState<boolean>(true);
  const [aiGuidance, setAiGuidance] = useState<string>('');
  const [generating, setGenerating] = useState(false);

  // Library filters
  const [libOwnerFilter, setLibOwnerFilter] = useState<'all' | 'mine'>('all');
  const [libSourceFilter, setLibSourceFilter] = useState<
    'all' | 'template' | 'ai_generated'
  >('all');
  const [libRoleFilter, setLibRoleFilter] = useState<string>('all');

  // Issuance form state
  const [candidateEmail, setCandidateEmail] = useState('');
  const [reviewerPrincipalId, setReviewerPrincipalId] = useState<string>(
    teamMembers.find((m) => m.principalId === currentPrincipalId)
      ?.principalId ??
      teamMembers[0]?.principalId ??
      currentPrincipalId,
  );
  const [expiresInDays, setExpiresInDays] = useState<number>(7);
  const [invitationNote, setInvitationNote] = useState('');

  // Status / Feedback state
  const [savingLibrary, setSavingLibrary] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [issuedResult, setIssuedResult] = useState<{
    sessionId: string;
    candidateLink: string;
    expiresAt: string;
    creditConsumed: boolean;
    creditsUsed: number;
    creditsPurchased: number;
  } | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);

  const orgBase = `/r23/organizations/${encodeURIComponent(organizationId)}`;
  const canUseAiBuilder = hasPlanFeature(plan.planTier, 'aiAssessmentBuilder');
  const trimmedEmail = candidateEmail.trim().toLowerCase();
  const alreadyCreditedCandidate =
    trimmedEmail.length > 0 && plan.creditedEmails.includes(trimmedEmail);
  const creditsBlocked =
    plan.planTier === 'none' ||
    (plan.planTier === 'per_candidate' &&
      (plan.candidateCreditsRemaining ?? 0) <= 0 &&
      !alreadyCreditedCandidate);

  const filteredLibrary = useMemo(() => {
    return library.filter((item) => {
      if (
        libOwnerFilter === 'mine' &&
        item.authorPrincipalId !== currentPrincipalId
      ) {
        return false;
      }
      if (libSourceFilter !== 'all' && item.sourceKind !== libSourceFilter) {
        return false;
      }
      if (libRoleFilter !== 'all' && item.targetRole !== libRoleFilter) {
        return false;
      }
      return true;
    });
  }, [
    library,
    libOwnerFilter,
    libSourceFilter,
    libRoleFilter,
    currentPrincipalId,
  ]);

  const activePreviewFile =
    activeDraft.starterFiles.find((f) => f.path === previewFilePath) ??
    activeDraft.starterFiles[0];

  const selectTemplate = (tpl: PlatformTemplateView) => {
    const nextDraft: R211AssessmentDraftInput = {
      ...tpl.baseDraft,
      durationMinutes: tplDuration,
      integratedAi: tplIntegratedAi,
    };
    setActiveDraft(nextDraft);
    setActiveSourceMeta({
      sourceKind: 'template',
      targetRole: tpl.targetRole,
      experienceLevel: tpl.experienceLevel,
      yearsExperience: tpl.yearsExperience,
      skills: tpl.skills,
      problemStructure: tpl.problemStructure,
      workKind: tpl.workKind,
      domain: tpl.domain,
    });
    setSavedIds(null);
    setPreviewFilePath(nextDraft.primaryFilePath);
    setIssuedResult(null);
    setErrorBanner(null);
    setStatusBanner(`Loaded platform template "${tpl.title}".`);
  };

  const selectSavedProblem = (problem: SavedLibraryProblem) => {
    const nextDraft = toDraftInput(problem);
    setActiveDraft(nextDraft);
    setActiveSourceMeta({
      sourceKind: problem.sourceKind,
      targetRole: problem.targetRole || HIRING_ROLES[0],
      experienceLevel: problem.experienceLevel,
      yearsExperience: problem.yearsExperience,
      skills: problem.skills,
      problemStructure: problem.problemStructure,
      workKind: problem.workKind,
      domain: problem.domain,
    });
    setSavedIds({
      definitionId: problem.definitionId,
      validatedVersionId: problem.validatedVersionId,
    });
    setPreviewFilePath(nextDraft.primaryFilePath);
    setIssuedResult(null);
    setErrorBanner(null);
    setStatusBanner(
      `Loaded "${problem.title}" from your Saved Problem Library.`,
    );
  };

  const toggleAiSkill = (skill: string) => {
    setAiSkills((prev) =>
      prev.includes(skill)
        ? prev.filter((item) => item !== skill)
        : prev.length >= 10
          ? prev
          : [...prev, skill],
    );
  };

  const handleGenerateAi = async () => {
    setErrorBanner(null);
    setStatusBanner(null);
    setIssuedResult(null);
    setGenerating(true);
    try {
      const csrf = readCsrfCookie();
      const response = await fetch(
        `/r23/api/organizations/${encodeURIComponent(organizationId)}/hiring/builder/generate`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(csrf ? { 'x-csrf-token': csrf } : {}),
          },
          body: JSON.stringify({
            csrf,
            targetRole: aiRole,
            experienceLevel: aiExpLevel,
            yearsExperience: aiYears,
            skills: aiSkills,
            problemStructure: aiStructure,
            workKind: aiWorkKind,
            domain: aiDomain,
            durationMinutes: aiDuration,
            integratedAi: aiIntegratedAi,
            guidance: aiGuidance,
          }),
        },
      );
      const data = (await response.json().catch(() => null)) as {
        draft?: R211AssessmentDraftInput;
        modelId?: string;
        error?: { message?: string };
      } | null;

      if (!response.ok || !data?.draft) {
        throw new Error(
          data?.error?.message ??
            `Unable to generate assessment (HTTP ${response.status}).`,
        );
      }

      setActiveDraft(data.draft);
      setActiveSourceMeta({
        sourceKind: 'ai_generated',
        targetRole: aiRole,
        experienceLevel: aiExpLevel,
        yearsExperience: aiYears,
        skills: aiSkills,
        problemStructure: aiStructure,
        workKind: aiWorkKind,
        domain: aiDomain,
        generationBrief: {
          workKind: aiWorkKind,
          domain: aiDomain,
          guidance: aiGuidance,
          modelId: data.modelId,
        },
      });
      setSavedIds(null);
      setPreviewFilePath(data.draft.primaryFilePath);
      setStatusBanner(
        `Generated "${data.draft.title}" with ${data.modelId ?? 'Kimi K3.1 Pro'}. Save to Library or issue directly below.`,
      );
    } catch (err) {
      setErrorBanner(
        err instanceof Error
          ? err.message
          : 'Unable to generate assessment with AI.',
      );
    } finally {
      setGenerating(false);
    }
  };

  const ensureSavedToLibrary = async (): Promise<{
    definitionId: string;
    validatedVersionId: string;
  }> => {
    if (savedIds) return savedIds;
    const csrf = readCsrfCookie();
    const apiBase = `/r23/api/organizations/${encodeURIComponent(organizationId)}/hiring`;
    const response = await fetch(`${apiBase}/library`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
      },
      body: JSON.stringify({
        csrf,
        draft: activeDraft,
        metadata: activeSourceMeta,
      }),
    });
    const data = (await response.json().catch(() => null)) as {
      definitionId?: string;
      validatedVersionId?: string;
      error?: { message?: string };
    } | null;

    if (!response.ok || !data?.definitionId || !data.validatedVersionId) {
      throw new Error(
        data?.error?.message ??
          `Unable to save problem to library (HTTP ${response.status}).`,
      );
    }

    const ids = {
      definitionId: data.definitionId,
      validatedVersionId: data.validatedVersionId,
    };
    setSavedIds(ids);

    // Refresh library list
    const listRes = await fetch(`${apiBase}/library`, {
      headers: { Accept: 'application/json' },
    }).catch(() => null);
    if (listRes?.ok) {
      const listJson = (await listRes.json().catch(() => null)) as {
        problems?: SavedLibraryProblem[];
      } | null;
      if (Array.isArray(listJson?.problems)) {
        setLibrary(listJson.problems);
      }
    }
    return ids;
  };

  const handleSaveLibraryOnly = async () => {
    setErrorBanner(null);
    setStatusBanner(null);
    setSavingLibrary(true);
    try {
      await ensureSavedToLibrary();
      setStatusBanner(
        `Saved "${activeDraft.title}" to your organization's Problem Library.`,
      );
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : 'Unable to save to library.',
      );
    } finally {
      setSavingLibrary(false);
    }
  };

  const handleIssue = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorBanner(null);
    setStatusBanner(null);
    setIssuedResult(null);
    setCopiedLink(false);

    if (!trimmedEmail.includes('@')) {
      setErrorBanner('Enter a valid candidate email address before issuing.');
      return;
    }
    setIssuing(true);
    try {
      const ids = await ensureSavedToLibrary();
      const csrf = readCsrfCookie();
      const apiBase = `/r23/api/organizations/${encodeURIComponent(organizationId)}/hiring`;
      const response = await fetch(`${apiBase}/issue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify({
          csrf,
          definitionId: ids.definitionId,
          validatedVersionId: ids.validatedVersionId,
          candidateEmail: trimmedEmail,
          reviewerPrincipalId,
          targetRole: activeSourceMeta.targetRole,
          experienceLevel: activeSourceMeta.experienceLevel,
          skills: activeSourceMeta.skills,
          invitationNote,
          expiresInDays,
          requestId: crypto.randomUUID(),
        }),
      });
      const data = (await response.json().catch(() => null)) as {
        ok?: boolean;
        sessionId?: string;
        candidateLink?: string;
        expiresAt?: string;
        creditConsumed?: boolean;
        creditsUsed?: number;
        creditsPurchased?: number;
        error?: { code?: string; message?: string };
      } | null;

      if (!response.ok || !data?.ok || !data.candidateLink || !data.sessionId) {
        throw new Error(
          data?.error?.message ??
            `Unable to issue assessment (HTTP ${response.status}).`,
        );
      }

      setIssuedResult({
        sessionId: data.sessionId,
        candidateLink: data.candidateLink,
        expiresAt: data.expiresAt ?? '',
        creditConsumed: Boolean(data.creditConsumed),
        creditsUsed: data.creditsUsed ?? plan.candidateCreditsUsed,
        creditsPurchased:
          data.creditsPurchased ?? plan.candidateCreditsPurchased,
      });

      if (typeof data.creditsUsed === 'number') {
        setPlan((prev) => ({
          ...prev,
          candidateCreditsUsed: data.creditsUsed ?? prev.candidateCreditsUsed,
          candidateCreditsRemaining:
            prev.planTier === 'per_candidate'
              ? Math.max(
                  0,
                  (data.creditsPurchased ?? prev.candidateCreditsPurchased) -
                    (data.creditsUsed ?? prev.candidateCreditsUsed),
                )
              : null,
          creditedEmails: prev.creditedEmails.includes(trimmedEmail)
            ? prev.creditedEmails
            : [...prev.creditedEmails, trimmedEmail],
        }));
      }

      setStatusBanner(
        `Assessment issued to ${trimmedEmail}. It is now visible in their Candidate Portal and ready via direct link.`,
      );
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : 'Unable to issue assessment.',
      );
    } finally {
      setIssuing(false);
    }
  };

  const copyIssuedLink = async () => {
    if (!issuedResult) return;
    const absoluteUrl = `${window.location.origin}${issuedResult.candidateLink}`;
    await navigator.clipboard.writeText(absoluteUrl).catch(() => {});
    setCopiedLink(true);
  };

  return (
    <div className="hiring-page-shell">
      {creditsBlocked ? (
        <div className="hiring-banner hiring-banner-warning" role="alert">
          <div>
            <strong>
              {plan.planTier === 'none'
                ? 'Active plan required:'
                : 'No candidate slots remaining:'}
            </strong>{' '}
            {plan.planTier === 'none'
              ? 'Hirearchy does not have a free plan. Upgrade to Per Candidate, Pro, or Ultra in Team & Plan before issuing.'
              : `Used ${plan.candidateCreditsUsed}/${plan.candidateCreditsPurchased} purchased candidate slots. Add slots or upgrade to Pro/Ultra.`}
          </div>
          <a className="hiring-btn hiring-btn-sm" href={`${orgBase}/settings`}>
            Manage Plan &amp; Credits
          </a>
        </div>
      ) : null}

      <section className="hiring-card">
        <div
          className="hiring-builder-tabs"
          role="tablist"
          aria-label="Assessment source mode"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'templates'}
            className={`hiring-builder-tab${mode === 'templates' ? ' is-active' : ''}`}
            onClick={() => setMode('templates')}
          >
            <IconTemplate size={16} /> Platform Templates
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'ai'}
            className={`hiring-builder-tab${mode === 'ai' ? ' is-active' : ''}`}
            onClick={() => setMode('ai')}
          >
            <IconSparkles size={16} /> Generate with AI (Kimi K3.1 Pro)
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'library'}
            className={`hiring-builder-tab${mode === 'library' ? ' is-active' : ''}`}
            onClick={() => setMode('library')}
          >
            <IconBookmark size={16} /> Saved Problem Library ({library.length})
          </button>
        </div>

        {mode === 'templates' ? (
          <div className="hiring-page-shell" style={{ marginTop: '18px' }}>
            <div className="hiring-two-col">
              <div className="hiring-field">
                <label htmlFor="tpl-duration">Session duration</label>
                <select
                  id="tpl-duration"
                  value={tplDuration}
                  onChange={(e) => {
                    const next = Number(e.target.value) as 30 | 45 | 60 | 90;
                    setTplDuration(next);
                  }}
                >
                  <option value={30}>30 minutes</option>
                  <option value={45}>45 minutes</option>
                  <option value={60}>60 minutes</option>
                  <option value={90}>90 minutes</option>
                </select>
              </div>
              <div className="hiring-field">
                <span className="hiring-field-label">
                  Candidate Workspace AI
                </span>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    minHeight: '38px',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={tplIntegratedAi}
                    onChange={(e) => setTplIntegratedAi(e.target.checked)}
                  />
                  Enable Kimi K3.1 Pro assistant inside Candidate IDE
                </label>
              </div>
            </div>

            <div className="hiring-problem-grid">
              {initialTemplates.map((tpl) => {
                const selected =
                  activeSourceMeta.sourceKind === 'template' &&
                  activeDraft.templateId === tpl.templateId;
                return (
                  <article
                    key={tpl.templateId}
                    className={`hiring-problem-card${selected ? ' is-selected' : ''}`}
                  >
                    <div>
                      <div
                        className="hiring-chip-group"
                        style={{ marginBottom: '8px' }}
                      >
                        <span className="hiring-pill hiring-pill-plum">
                          {tpl.targetRole}
                        </span>
                        <span className="hiring-pill">
                          {experienceLevelLabel(tpl.experienceLevel)}
                        </span>
                        <span className="hiring-pill">
                          {tpl.problemStructure === 'multi_file'
                            ? 'Multi-file'
                            : 'Single-module'}
                        </span>
                      </div>
                      <h3>{tpl.title}</h3>
                      <p
                        style={{
                          fontSize: '13px',
                          color: 'var(--software-muted)',
                        }}
                      >
                        {tpl.summary}
                      </p>
                      <div
                        className="hiring-chip-group"
                        style={{ marginTop: '8px' }}
                      >
                        {tpl.skills.map((s) => (
                          <span key={s} className="hiring-pill">
                            {s}
                          </span>
                        ))}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`hiring-btn${selected ? ' hiring-btn-primary' : ''}`}
                      onClick={() => selectTemplate(tpl)}
                    >
                      {selected ? 'Selected in Preview' : 'Load Template'}
                    </button>
                  </article>
                );
              })}
            </div>
          </div>
        ) : null}

        {mode === 'ai' ? (
          <div className="hiring-page-shell" style={{ marginTop: '18px' }}>
            {!canUseAiBuilder ? (
              <div className="hiring-banner hiring-banner-warning">
                <div>
                  <strong>Active paid plan required:</strong> Activate Per
                  Candidate, Pro, or Ultra in Team &amp; Plan to unlock AI
                  problem generation.
                </div>
                <a
                  className="hiring-btn hiring-btn-sm"
                  href={`${orgBase}/settings`}
                >
                  Choose Plan
                </a>
              </div>
            ) : null}

            <div className="hiring-filter-grid">
              <div className="hiring-field">
                <label htmlFor="ai-role">Target role</label>
                <select
                  id="ai-role"
                  value={aiRole}
                  onChange={(e) => setAiRole(e.target.value)}
                >
                  {HIRING_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </div>

              <div className="hiring-field">
                <label htmlFor="ai-level">Seniority level</label>
                <select
                  id="ai-level"
                  value={aiExpLevel}
                  onChange={(e) => {
                    const lvl = e.target.value as ExperienceLevelId;
                    setAiExpLevel(lvl);
                    const found = EXPERIENCE_LEVELS.find((x) => x.id === lvl);
                    if (found) setAiYears(found.defaultYears);
                  }}
                >
                  {EXPERIENCE_LEVELS.map((lvl) => (
                    <option key={lvl.id} value={lvl.id}>
                      {lvl.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="hiring-field">
                <label htmlFor="ai-years">Years of experience</label>
                <select
                  id="ai-years"
                  value={aiYears}
                  onChange={(e) => setAiYears(Number(e.target.value))}
                >
                  {YEARS_EXPERIENCE_OPTIONS.map((y) => (
                    <option key={y.value} value={y.value}>
                      {y.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="hiring-field">
                <label htmlFor="ai-structure">Repository structure</label>
                <select
                  id="ai-structure"
                  value={aiStructure}
                  onChange={(e) =>
                    setAiStructure(e.target.value as ProblemStructureId)
                  }
                >
                  {PROBLEM_STRUCTURE_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="hiring-field">
                <label htmlFor="ai-work-kind">Work scenario focus</label>
                <select
                  id="ai-work-kind"
                  value={aiWorkKind}
                  onChange={(e) => setAiWorkKind(e.target.value)}
                >
                  {WORK_KIND_OPTIONS.map((wk) => (
                    <option key={wk.id} value={wk.id}>
                      {wk.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="hiring-field">
                <label htmlFor="ai-domain">Engineering domain</label>
                <select
                  id="ai-domain"
                  value={aiDomain}
                  onChange={(e) => setAiDomain(e.target.value)}
                >
                  {DOMAIN_OPTIONS.map((dom) => (
                    <option key={dom.id} value={dom.id}>
                      {dom.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="hiring-field">
                <label htmlFor="ai-duration">Duration</label>
                <select
                  id="ai-duration"
                  value={aiDuration}
                  onChange={(e) =>
                    setAiDuration(Number(e.target.value) as 30 | 45 | 60 | 90)
                  }
                >
                  <option value={30}>30 minutes</option>
                  <option value={45}>45 minutes</option>
                  <option value={60}>60 minutes</option>
                  <option value={90}>90 minutes</option>
                </select>
              </div>

              <div className="hiring-field">
                <span className="hiring-field-label">
                  Candidate AI Assistant
                </span>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    minHeight: '38px',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={aiIntegratedAi}
                    onChange={(e) => setAiIntegratedAi(e.target.checked)}
                  />
                  Enable Kimi K3.1 Pro inside workspace
                </label>
              </div>
            </div>

            <div className="hiring-field">
              <span className="hiring-field-label">
                Priority skills to test (select up to 10)
              </span>
              <div className="hiring-chip-group">
                {CURATED_SKILLS.map((skill) => {
                  const active = aiSkills.includes(skill);
                  return (
                    <button
                      key={skill}
                      type="button"
                      className={`hiring-chip${active ? ' is-active' : ''}`}
                      onClick={() => toggleAiSkill(skill)}
                      aria-pressed={active}
                    >
                      {skill}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="hiring-field">
              <label htmlFor="ai-guidance">
                Optional role focus note (for example: emphasize idempotent
                webhook retries or clock-skew handling)
              </label>
              <textarea
                id="ai-guidance"
                value={aiGuidance}
                onChange={(e) => setAiGuidance(e.target.value)}
                placeholder="Optional architectural context or tricky edge cases you want Kimi K3.1 Pro to include..."
              />
            </div>

            <div className="hiring-header-actions">
              <button
                type="button"
                className="hiring-btn hiring-btn-primary"
                disabled={generating || !canUseAiBuilder}
                onClick={handleGenerateAi}
              >
                <IconSparkles size={16} />{' '}
                {generating
                  ? 'Generating problem with Kimi K3.1 Pro...'
                  : 'Generate Assessment with Kimi K3.1 Pro'}
              </button>
            </div>
          </div>
        ) : null}

        {mode === 'library' ? (
          <div className="hiring-page-shell" style={{ marginTop: '18px' }}>
            <div className="hiring-filter-grid">
              <div className="hiring-field">
                <label htmlFor="lib-owner">Authored by</label>
                <select
                  id="lib-owner"
                  value={libOwnerFilter}
                  onChange={(e) =>
                    setLibOwnerFilter(e.target.value as 'all' | 'mine')
                  }
                >
                  <option value="all">All organization problems</option>
                  <option value="mine">My authored / saved problems</option>
                </select>
              </div>
              <div className="hiring-field">
                <label htmlFor="lib-source">Problem source</label>
                <select
                  id="lib-source"
                  value={libSourceFilter}
                  onChange={(e) =>
                    setLibSourceFilter(
                      e.target.value as 'all' | 'template' | 'ai_generated',
                    )
                  }
                >
                  <option value="all">All sources</option>
                  <option value="template">Platform Templates</option>
                  <option value="ai_generated">
                    AI Generated (Kimi K3.1 Pro)
                  </option>
                </select>
              </div>
              <div className="hiring-field">
                <label htmlFor="lib-role">Target role</label>
                <select
                  id="lib-role"
                  value={libRoleFilter}
                  onChange={(e) => setLibRoleFilter(e.target.value)}
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

            {filteredLibrary.length === 0 ? (
              <p style={{ color: 'var(--software-muted)', fontSize: '13px' }}>
                No saved problems match these filters yet. Load a Platform
                Template or generate a problem with Kimi K3.1 Pro and save it
                for reuse.
              </p>
            ) : (
              <div className="hiring-problem-grid">
                {filteredLibrary.map((problem) => {
                  const isSelected =
                    savedIds?.definitionId === problem.definitionId;
                  return (
                    <article
                      key={problem.definitionId}
                      className={`hiring-problem-card${isSelected ? ' is-selected' : ''}`}
                    >
                      <div>
                        <div
                          className="hiring-chip-group"
                          style={{ marginBottom: '8px' }}
                        >
                          <span className="hiring-pill hiring-pill-plum">
                            {problem.sourceKind === 'template'
                              ? 'Template'
                              : 'Kimi K3.1 Pro AI'}
                          </span>
                          <span className="hiring-pill">
                            {problem.targetRole || 'General'}
                          </span>
                          <span className="hiring-pill">
                            Issued {problem.issuedCount}×
                          </span>
                        </div>
                        <h3>{problem.title}</h3>
                        <p
                          style={{
                            fontSize: '12px',
                            color: 'var(--software-muted)',
                          }}
                        >
                          By {problem.authorName} · {problem.durationMinutes}{' '}
                          min · {experienceLevelLabel(problem.experienceLevel)}
                        </p>
                      </div>
                      <button
                        type="button"
                        className={`hiring-btn${isSelected ? ' hiring-btn-primary' : ''}`}
                        onClick={() => selectSavedProblem(problem)}
                      >
                        {isSelected ? 'Loaded in Preview' : 'Reuse Problem'}
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}
      </section>

      {errorBanner ? (
        <div className="hiring-banner hiring-banner-danger" role="alert">
          {errorBanner}
        </div>
      ) : null}
      {statusBanner ? (
        <div className="hiring-banner hiring-banner-success" role="status">
          {statusBanner}
        </div>
      ) : null}

      <section className="hiring-card">
        <header
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            marginBottom: '14px',
          }}
        >
          <div>
            <span className="hiring-eyebrow">Read-only Problem Preview</span>
            <h2>{activeDraft.title}</h2>
            <div className="hiring-chip-group" style={{ marginTop: '6px' }}>
              <span className="hiring-pill hiring-pill-plum">
                {activeSourceMeta.targetRole}
              </span>
              <span className="hiring-pill">
                {experienceLevelLabel(activeSourceMeta.experienceLevel)}
              </span>
              <span className="hiring-pill">
                {activeDraft.durationMinutes} min
              </span>
              <span className="hiring-pill">
                {activeDraft.starterFiles.length} workspace file
                {activeDraft.starterFiles.length === 1 ? '' : 's'}
              </span>
              <span className="hiring-pill">
                Candidate AI:{' '}
                {activeDraft.integratedAi
                  ? 'Enabled (Kimi K3.1 Pro)'
                  : 'Disabled'}
              </span>
              {savedIds ? (
                <span className="hiring-pill hiring-pill-success">
                  <IconCheck size={12} /> Saved in Library
                </span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            className="hiring-btn"
            disabled={savingLibrary || Boolean(savedIds)}
            onClick={handleSaveLibraryOnly}
          >
            <IconBookmark size={16} />{' '}
            {savedIds
              ? 'Saved in Problem Library'
              : savingLibrary
                ? 'Saving...'
                : 'Save to Problem Library'}
          </button>
        </header>

        <p style={{ fontSize: '14px', lineHeight: 1.55 }}>
          {activeDraft.brief}
        </p>

        <div className="hiring-two-col" style={{ marginTop: '16px' }}>
          <div className="hiring-card-subtle">
            <strong>Acceptance Criteria</strong>
            <ul
              style={{
                margin: '8px 0 0',
                paddingLeft: '18px',
                fontSize: '13px',
              }}
            >
              {activeDraft.acceptanceCriteria.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="hiring-card-subtle">
            <strong>Evaluation Rubric</strong>
            <ul
              style={{
                margin: '8px 0 0',
                paddingLeft: '18px',
                fontSize: '13px',
              }}
            >
              {activeDraft.rubric.map((item) => (
                <li key={item.id}>
                  <strong>{item.label}</strong> ({item.weight}%):{' '}
                  {item.description}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div style={{ marginTop: '16px' }}>
          <div className="hiring-chip-group" style={{ marginBottom: '10px' }}>
            {activeDraft.starterFiles.map((file) => {
              const active = file.path === activePreviewFile?.path;
              return (
                <button
                  key={file.path}
                  type="button"
                  className={`hiring-chip${active ? ' is-active' : ''}`}
                  onClick={() => setPreviewFilePath(file.path)}
                >
                  <IconFileCode size={13} /> {file.path}
                </button>
              );
            })}
          </div>
          {activePreviewFile ? (
            <pre className="hiring-file-preview">
              {activePreviewFile.content}
            </pre>
          ) : null}
        </div>
      </section>

      <section className="hiring-card">
        <span className="hiring-eyebrow">
          Issue to Candidate · {formatPlanBadge(plan)}
        </span>
        <h2>Send Assessment Invitation</h2>
        <p
          style={{
            fontSize: '13px',
            color: 'var(--software-muted)',
            marginTop: '4px',
          }}
        >
          Candidates must sign in with a matching Hirearchy Candidate Account to
          launch their isolated workspace. The assessment also appears
          immediately in their <code>/candidate</code> portal.
        </p>

        <form
          onSubmit={handleIssue}
          className="hiring-page-shell"
          style={{ marginTop: '14px' }}
        >
          <div className="hiring-filter-grid">
            <div className="hiring-field">
              <label htmlFor="issue-candidate-email">Candidate email</label>
              <input
                id="issue-candidate-email"
                type="email"
                required
                value={candidateEmail}
                onChange={(e) => setCandidateEmail(e.target.value)}
                placeholder="candidate@example.com"
              />
            </div>

            <div className="hiring-field">
              <label htmlFor="issue-reviewer">Assigned evaluator</label>
              <select
                id="issue-reviewer"
                value={reviewerPrincipalId}
                onChange={(e) => setReviewerPrincipalId(e.target.value)}
              >
                {teamMembers.map((member) => (
                  <option key={member.principalId} value={member.principalId}>
                    {member.displayName || member.email} ({member.role})
                  </option>
                ))}
              </select>
            </div>

            <div className="hiring-field">
              <label htmlFor="issue-expiry">Invitation expiry</label>
              <select
                id="issue-expiry"
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(Number(e.target.value))}
              >
                {INVITATION_EXPIRY_OPTIONS.map((opt) => (
                  <option key={opt.days} value={opt.days}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="hiring-field">
            <label htmlFor="issue-note">
              Internal hiring context / note (visible to team only)
            </label>
            <input
              id="issue-note"
              type="text"
              maxLength={400}
              value={invitationNote}
              onChange={(e) => setInvitationNote(e.target.value)}
              placeholder="e.g. Senior Payments Backend screen — focus on concurrency"
            />
          </div>

          <div className="hiring-header-actions">
            <button
              type="submit"
              className="hiring-btn hiring-btn-primary"
              disabled={issuing || creditsBlocked}
            >
              <IconSend size={16} />{' '}
              {issuing ? 'Issuing assessment...' : 'Save & Issue Assessment'}
            </button>
          </div>
        </form>

        {issuedResult ? (
          <div className="hiring-card-subtle" style={{ marginTop: '16px' }}>
            <div className="hiring-candidate-name">
              <strong>Assessment Issued</strong>
              <span className="hiring-pill hiring-pill-success">
                Candidate Portal Synced
              </span>
            </div>
            <p style={{ fontSize: '13px', marginTop: '8px' }}>
              Share this direct invitation link with{' '}
              <strong>{trimmedEmail}</strong> (they can also start it directly
              from <code>/candidate</code>):
            </p>
            <div
              style={{
                display: 'flex',
                gap: '8px',
                marginTop: '8px',
                flexWrap: 'wrap',
              }}
            >
              <input
                type="text"
                readOnly
                value={issuedResult.candidateLink}
                aria-label="Issued candidate link"
                style={{
                  flex: '1 1 320px',
                  padding: '8px 10px',
                  borderRadius: '8px',
                  border: '1px solid var(--software-border)',
                  fontFamily: 'var(--software-mono)',
                  fontSize: '12px',
                }}
              />
              <button
                type="button"
                className="hiring-btn hiring-btn-mint"
                onClick={copyIssuedLink}
              >
                <IconCopy size={15} /> {copiedLink ? 'Copied' : 'Copy link'}
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
