'use client';

import { useMemo, useState } from 'react';
import {
  IconArrowRight,
  IconBookmark,
  IconCheck,
  IconCopy,
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
import { ScenarioBrief } from '../../../../../src/ui/scenario-brief';
import { RepositoryInspector } from './repository-inspector';

export interface HiringAssessmentBuilderClientProps {
  readonly organizationId: string;
  readonly currentPrincipalId: string;
  readonly initialPlan: OrganizationPlanSummary;
  readonly initialLibrary: readonly SavedLibraryProblem[];
  readonly initialTemplates: readonly PlatformTemplateView[];
  readonly teamMembers: readonly TeamMemberOption[];
}

type BuilderMode = 'templates' | 'ai' | 'library';
type BuilderStage = 'source' | 'preview' | 'invite';

type PreviewTab = 'overview' | 'repository' | 'rubric';

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
  const [stage, setStage] = useState<BuilderStage>('source');
  const [mode, setMode] = useState<BuilderMode>('templates');
  const [previewTab, setPreviewTab] = useState<PreviewTab>('overview');

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

  const [tplDuration, setTplDuration] = useState<30 | 45 | 60 | 90>(60);
  const [tplIntegratedAi, setTplIntegratedAi] = useState(false);

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

  const [libOwnerFilter, setLibOwnerFilter] = useState<'all' | 'mine'>('all');
  const [libSourceFilter, setLibSourceFilter] = useState<
    'all' | 'template' | 'ai_generated'
  >('all');
  const [libRoleFilter, setLibRoleFilter] = useState<string>('all');

  const [candidateEmail, setCandidateEmail] = useState('');
  const [reviewerPrincipalId, setReviewerPrincipalId] = useState<string>(
    teamMembers.find((m) => m.principalId === currentPrincipalId)
      ?.principalId ??
      teamMembers[0]?.principalId ??
      currentPrincipalId,
  );
  const [expiresInDays, setExpiresInDays] = useState<number>(7);
  const [invitationNote, setInvitationNote] = useState('');

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
      setStage('preview');
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

  const stages = [
    { id: 'source', title: 'Problem', detail: 'Choose the work' },
    {
      id: 'preview',
      title: 'Candidate preview',
      detail: `${activeDraft.starterFiles.length} files · ${activeDraft.durationMinutes} min`,
    },
    {
      id: 'invite',
      title: 'Invitation',
      detail: issuedResult ? 'Ready to share' : formatPlanBadge(plan),
    },
  ] as const;

  return (
    <div className="software-builder-flow">
      <nav
        className="software-builder-stages"
        aria-label="Assessment builder steps"
      >
        <ol>
          {stages.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                aria-current={stage === item.id ? 'step' : undefined}
                onClick={() => setStage(item.id)}
              >
                <strong>{item.title}</strong>
                <span>{item.detail}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <div className="software-builder-content">
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

        {stage === 'invite' && creditsBlocked ? (
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
            <a
              className="hiring-btn hiring-btn-sm"
              href={`${orgBase}/settings`}
            >
              View organization plan
            </a>
          </div>
        ) : null}

        <section
          id="problem-source"
          hidden={stage !== 'source'}
          className="software-builder-stage hiring-card"
        >
          <div className="hiring-builder-head">
            <div>
              <h2>Problem source</h2>
            </div>
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
                <IconTemplate size={16} /> Templates
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'ai'}
                className={`hiring-builder-tab${mode === 'ai' ? ' is-active' : ''}`}
                onClick={() => setMode('ai')}
              >
                <IconSparkles size={16} /> Generate with AI
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'library'}
                className={`hiring-builder-tab${mode === 'library' ? ' is-active' : ''}`}
                onClick={() => setMode('library')}
              >
                <IconBookmark size={16} /> Problem library
              </button>
            </div>
          </div>

          {mode === 'templates' ? (
            <div className="hiring-builder-pane">
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
                  <label className="hiring-switch-row">
                    <input
                      type="checkbox"
                      className="hiring-switch-input"
                      checked={tplIntegratedAi}
                      onChange={(e) => setTplIntegratedAi(e.target.checked)}
                    />
                    <span className="hiring-switch-track" aria-hidden="true" />
                    <span className="hiring-switch-copy">
                      Enable Kimi K3.1 Pro assistant inside Candidate IDE
                    </span>
                  </label>
                </div>
              </div>

              <div className="software-problem-list">
                {initialTemplates.map((tpl) => {
                  const selected =
                    activeSourceMeta.sourceKind === 'template' &&
                    activeDraft.templateId === tpl.templateId;
                  return (
                    <article
                      key={tpl.templateId}
                      className={`software-problem-row${selected ? ' is-selected' : ''}`}
                    >
                      <div className="hiring-stack-xs">
                        <div className="hiring-chip-group">
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
                        <p className="hiring-muted-copy">{tpl.summary}</p>
                        <div className="hiring-chip-group">
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
                        onClick={() => {
                          selectTemplate(tpl);
                          setStage('preview');
                        }}
                      >
                        Preview template{' '}
                        <IconArrowRight size={15} aria-hidden="true" />
                      </button>
                    </article>
                  );
                })}
              </div>
            </div>
          ) : null}

          {mode === 'ai' ? (
            <div className="hiring-builder-pane">
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

              <div className="hiring-ai-studio">
                <div className="hiring-ai-studio-head">
                  <div className="hiring-ai-studio-badge">
                    <IconSparkles size={15} /> Kimi K3.1 Pro Studio
                  </div>
                  <span className="hiring-muted-copy">
                    Review the generated brief, code and rubric before issuing
                    the assessment.
                  </span>
                </div>

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
                        const found = EXPERIENCE_LEVELS.find(
                          (x) => x.id === lvl,
                        );
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
                        setAiDuration(
                          Number(e.target.value) as 30 | 45 | 60 | 90,
                        )
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
                    <label className="hiring-switch-row">
                      <input
                        type="checkbox"
                        className="hiring-switch-input"
                        checked={aiIntegratedAi}
                        onChange={(e) => setAiIntegratedAi(e.target.checked)}
                      />
                      <span
                        className="hiring-switch-track"
                        aria-hidden="true"
                      />
                      <span className="hiring-switch-copy">
                        Enable Kimi K3.1 Pro inside workspace
                      </span>
                    </label>
                  </div>
                </div>

                <div className="hiring-field">
                  <span className="hiring-field-label">
                    Priority skills to test ({aiSkills.length}/10 selected)
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
            </div>
          ) : null}

          {mode === 'library' ? (
            <div className="hiring-builder-pane">
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
                <p className="hiring-muted-copy">
                  No saved problems match these filters yet. Load a Platform
                  Template or generate a problem with Kimi K3.1 Pro and save it
                  for reuse.
                </p>
              ) : (
                <div className="software-problem-list">
                  {filteredLibrary.map((problem) => {
                    const isSelected =
                      savedIds?.definitionId === problem.definitionId;
                    return (
                      <article
                        key={problem.definitionId}
                        className={`software-problem-row${isSelected ? ' is-selected' : ''}`}
                      >
                        <div className="hiring-stack-xs">
                          <div className="hiring-chip-group">
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
                          <p className="hiring-muted-copy">
                            By {problem.authorName} · {problem.durationMinutes}{' '}
                            min ·{' '}
                            {experienceLevelLabel(problem.experienceLevel)}
                          </p>
                        </div>
                        <button
                          type="button"
                          className={`hiring-btn${isSelected ? ' hiring-btn-primary' : ''}`}
                          onClick={() => {
                            selectSavedProblem(problem);
                            setStage('preview');
                          }}
                        >
                          Preview saved problem{' '}
                          <IconArrowRight size={15} aria-hidden="true" />
                        </button>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
        </section>

        <section
          id="candidate-preview"
          hidden={stage !== 'preview'}
          className="software-builder-stage hiring-card"
        >
          <header className="hiring-preview-header">
            <div className="hiring-stack-xs">
              <span className="hiring-eyebrow">Candidate workspace</span>
              <h2>{activeDraft.title}</h2>
              <div className="hiring-chip-group">
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
                  {activeDraft.starterFiles.length} workspace{' '}
                  {activeDraft.starterFiles.length === 1 ? 'file' : 'files'}
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

          <div className="hiring-preview-subtabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={previewTab === 'overview'}
              className={`hiring-preview-subtab${previewTab === 'overview' ? ' is-active' : ''}`}
              onClick={() => setPreviewTab('overview')}
            >
              Brief &amp; criteria
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={previewTab === 'repository'}
              className={`hiring-preview-subtab${previewTab === 'repository' ? ' is-active' : ''}`}
              onClick={() => setPreviewTab('repository')}
            >
              Repository files
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={previewTab === 'rubric'}
              className={`hiring-preview-subtab${previewTab === 'rubric' ? ' is-active' : ''}`}
              onClick={() => setPreviewTab('rubric')}
            >
              Rubric
            </button>
          </div>

          {previewTab === 'overview' ? (
            <div className="hiring-preview-panel">
              <ScenarioBrief markdown={activeDraft.brief} />
              <div className="hiring-card-subtle">
                <strong>Acceptance Criteria</strong>
                <ul className="hiring-bullet-list">
                  {activeDraft.acceptanceCriteria.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : previewTab === 'rubric' ? (
            <div className="hiring-preview-panel">
              <div className="hiring-rubric-list">
                {activeDraft.rubric.map((item) => (
                  <article key={item.id} className="hiring-rubric-item">
                    <div className="hiring-rubric-row">
                      <strong>{item.label}</strong>
                      <span className="hiring-pill hiring-pill-plum">
                        {item.weight}% weight
                      </span>
                    </div>
                    <progress
                      className="hiring-rubric-progress"
                      value={item.weight}
                      max={100}
                      aria-label={`${item.label} rubric weight ${item.weight} percent`}
                    />
                    <p className="hiring-muted-copy">{item.description}</p>
                  </article>
                ))}
              </div>
            </div>
          ) : (
            <div className="software-repo-preview">
              <div className="software-repo-intro">
                <span className="hiring-eyebrow">Starter Repository</span>
                <span className="hiring-muted-copy">
                  Files the candidate receives
                </span>
              </div>
              <RepositoryInspector
                files={activeDraft.starterFiles}
                workspaceName={activeDraft.title}
                activePath={previewFilePath}
                onSelectPath={setPreviewFilePath}
              />
            </div>
          )}
          <footer className="software-builder-next">
            <button
              type="button"
              className="hiring-btn hiring-btn-primary"
              onClick={() => setStage('invite')}
            >
              Continue to invitation{' '}
              <IconArrowRight size={15} aria-hidden="true" />
            </button>
          </footer>
        </section>

        <section
          id="issue-invitation"
          hidden={stage !== 'invite'}
          className="software-builder-stage hiring-card"
        >
          <header className="hiring-preview-header">
            <div className="hiring-stack-xs">
              <h2>Issue the invitation</h2>
              <strong>
                {activeDraft.title} · {activeDraft.durationMinutes} min
              </strong>
              <p className="hiring-muted-copy">
                The invitation appears in the candidate’s account. They can also
                open the link you share.
              </p>
            </div>
            <div className="hiring-slot-meter">
              {plan.planTier === 'per_candidate' ? (
                <>
                  <div className="hiring-slot-meter-head">
                    <span>Candidate Slots</span>
                    <strong>
                      {plan.candidateCreditsUsed}/
                      {plan.candidateCreditsPurchased} used
                    </strong>
                  </div>
                  <progress
                    className="hiring-slot-progress"
                    value={plan.candidateCreditsUsed}
                    max={Math.max(1, plan.candidateCreditsPurchased)}
                    aria-label="Candidate slots used"
                  />
                  <span className="hiring-slot-note">
                    {alreadyCreditedCandidate
                      ? 'Candidate already credited — 0 extra slots'
                      : `${plan.candidateCreditsRemaining ?? 0} remaining`}
                  </span>
                </>
              ) : plan.planTier === 'none' ? (
                <span className="hiring-pill hiring-pill-danger">
                  No active plan
                </span>
              ) : (
                <div className="hiring-slot-unlimited">
                  <span className="hiring-pill hiring-pill-success">
                    Unlimited candidate capacity
                  </span>
                  <span className="hiring-slot-note">
                    {plan.candidateCreditsUsed} distinct candidates assessed
                  </span>
                </div>
              )}
            </div>
          </header>

          <form onSubmit={handleIssue} className="hiring-issue-form">
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
            <div className="hiring-issued-box">
              <div className="hiring-candidate-name">
                <strong>Assessment Issued</strong>
                <span className="hiring-pill hiring-pill-success">
                  Candidate Portal Synced
                </span>
              </div>
              <p className="hiring-muted-copy">
                Share this direct invitation link with{' '}
                <strong>{trimmedEmail}</strong> (they can also start it directly
                from <code>/candidate</code>):
              </p>
              <div className="hiring-issued-link-row">
                <input
                  type="text"
                  readOnly
                  value={issuedResult.candidateLink}
                  aria-label="Issued candidate link"
                  className="hiring-issued-link-input"
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
    </div>
  );
}
