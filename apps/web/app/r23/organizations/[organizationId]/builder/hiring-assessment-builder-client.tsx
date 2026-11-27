'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import {
  IconArrowRight,
  IconBookmark,
  IconCheck,
  IconCodePlus,
  IconEye,
  IconPlus,
  IconSend,
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
import type { BuilderGenerationJobView } from '../../../../../src/hiring/builder-generation-jobs';
import {
  hasPlanFeature,
  type OrganizationPlanSummary,
} from '../../../../../src/plans/entitlements';
import type { R211AssessmentDraftInput } from '../../../../../src/r211-builder/contract';
import {
  readPersistedJson,
  writePersistedJson,
} from '../../../../../src/ui/browser-state';
import { ScenarioBrief } from '../../../../../src/ui/scenario-brief';
import { HirearchyAiThinking } from '../../../../_components/ai';
import { emitToast } from '../../../../_components/brand-toast';
import { CopyActionButton } from '../../../../_components/copy-action-button';
import { HorizontalTabs } from '../../../../_components/horizontal-tabs';
import { LocalTime } from '../../../../_components/local-time';
import { CommonThreadLoader } from '../../../../_components/common-thread-loader';
import { ProductFeedbackPulse } from '../../../../_components/product-feedback-pulse';
import {
  healthFlagMeta,
  type OrgProblemHealthItem,
} from '../../../_components/org-benchmarks-strip';
import { CANDIDATE_PREVIEW_DRAFT_KEY_PREFIX } from './candidate-preview/candidate-preview-client';
import { trackClientEvent } from '../../../../../src/telemetry/client';

const RepositoryInspector = dynamic(
  () => import('./repository-inspector').then((m) => m.RepositoryInspector),
  {
    ssr: false,
    loading: () => (
      <div style={{ padding: '1rem' }}>
        <CommonThreadLoader compact label="Loading repository preview…" />
      </div>
    ),
  },
);

export interface HiringAssessmentBuilderClientProps {
  readonly organizationId: string;
  readonly currentPrincipalId: string;
  readonly initialPlan: OrganizationPlanSummary;
  readonly initialLibrary: readonly SavedLibraryProblem[];
  readonly initialTemplates: readonly PlatformTemplateView[];
  readonly teamMembers: readonly TeamMemberOption[];
  readonly initialMode?: BuilderMode;
  readonly fresh?: boolean;
  readonly draftId?: string;
  readonly initialGenerationJob?: BuilderGenerationJobView | null;
}

type BuilderMode = 'templates' | 'ai' | 'library';
type BuilderStage = 'source' | 'preview' | 'invite';

type PreviewTab = 'overview' | 'repository' | 'rubric';

const defaultAiSkills = [
  'Python',
  'Concurrency & Idempotency',
  'Testing & Debugging',
];

type BuilderDraftContent = {
  problemSelected?: boolean;
  mode?: BuilderMode;
  tplDuration?: number;
  tplIntegratedAi?: boolean;
  aiConfig?: {
    role?: string;
    expLevel?: ExperienceLevelId;
    years?: number;
    skills?: readonly string[];
    structure?: ProblemStructureId;
    workKind?: string;
    domain?: string;
    duration?: number;
    integratedAi?: boolean;
    guidance?: string;
  };
};

function hasBuilderDraftContent(draft: BuilderDraftContent | null): boolean {
  const ai = draft?.aiConfig;
  return Boolean(
    draft?.problemSelected ||
    (draft?.tplDuration ?? 60) !== 60 ||
    draft?.tplIntegratedAi ||
    (ai?.role ?? HIRING_ROLES[0]) !== HIRING_ROLES[0] ||
    (ai?.expLevel ?? 'mid') !== 'mid' ||
    (ai?.years ?? 3) !== 3 ||
    (ai?.skills ?? defaultAiSkills).join(',') !== defaultAiSkills.join(',') ||
    (ai?.structure ?? 'multi_file') !== 'multi_file' ||
    (ai?.workKind ?? WORK_KIND_OPTIONS[0].id) !== WORK_KIND_OPTIONS[0].id ||
    (ai?.domain ?? DOMAIN_OPTIONS[0].id) !== DOMAIN_OPTIONS[0].id ||
    (ai?.duration ?? 60) !== 60 ||
    ai?.integratedAi ||
    ai?.guidance?.trim(),
  );
}

type SavedBuilderDraft = { id: string; title: string; updatedAt: string };

function readSavedBuilderDrafts(
  legacyKey: string,
  draftPrefix: string,
): SavedBuilderDraft[] {
  const drafts = new Map<string, SavedBuilderDraft>();
  for (const storage of [window.sessionStorage, window.localStorage]) {
    for (const key of Object.keys(storage)) {
      if (key !== legacyKey && !key.startsWith(draftPrefix)) continue;
      const id = key === legacyKey ? 'legacy' : key.slice(draftPrefix.length);
      try {
        const saved = JSON.parse(storage.getItem(key) ?? 'null');
        if (!hasBuilderDraftContent(saved) || saved.completed) {
          drafts.delete(id);
          continue;
        }
        drafts.set(id, {
          id,
          title: saved.problemSelected
            ? saved.draft?.title || 'Assessment draft'
            : 'Unfinished assessment',
          updatedAt: saved.updatedAt ?? '',
        });
      } catch {
        // A corrupt draft must not hide the rest of the saved work.
      }
    }
  }
  return [...drafts.values()].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}

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
  initialMode = 'templates',
  fresh = false,
  draftId,
  initialGenerationJob = null,
}: HiringAssessmentBuilderClientProps) {
  const initialRunningJob =
    initialGenerationJob?.status === 'running' ? initialGenerationJob : null;
  const hasInitialRunningJob = Boolean(initialRunningJob);
  const [plan, setPlan] = useState<OrganizationPlanSummary>(initialPlan);
  const [library, setLibrary] =
    useState<readonly SavedLibraryProblem[]>(initialLibrary);
  const [stage, setStage] = useState<BuilderStage>('source');
  const [problemSelected, setProblemSelected] = useState(false);
  const [previewVisited, setPreviewVisited] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [draftCompleted, setDraftCompleted] = useState(false);
  const builderFlow = useRef<HTMLDivElement>(null);

  const showStage = (nextStage: BuilderStage) => {
    setStage(nextStage);
    requestAnimationFrame(() => {
      document
        .getElementById(`builder-stage-${nextStage}`)
        ?.focus({ preventScroll: true });
      const flow = builderFlow.current;
      const headerBottom =
        document
          .querySelector('.software-document-header')
          ?.getBoundingClientRect().bottom ?? 0;
      if (flow && flow.getBoundingClientRect().top < headerBottom) {
        flow.scrollIntoView({ block: 'start' });
      }
    });
  };

  const goToStage = (nextStage: BuilderStage) => {
    if (!problemSelected && nextStage !== 'source') {
      setErrorBanner(
        'Select a template, load a saved problem, or generate an assessment with AI before moving to Preview or Invite.',
      );
      return;
    }
    setErrorBanner(null);
    if (nextStage === 'preview') {
      setPreviewVisited(true);
    }
    showStage(nextStage);
  };
  const [mode, setMode] = useState<BuilderMode>(
    initialRunningJob ? 'ai' : initialMode,
  );
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

  const [aiRole, setAiRole] = useState<string>(
    initialRunningJob?.targetRole ?? HIRING_ROLES[0],
  );
  const [aiExpLevel, setAiExpLevel] = useState<ExperienceLevelId>(
    initialRunningJob?.experienceLevel ?? 'mid',
  );
  const [aiYears, setAiYears] = useState<number>(
    initialRunningJob?.yearsExperience ?? 3,
  );
  const [aiSkills, setAiSkills] = useState<string[]>(
    initialRunningJob ? [...initialRunningJob.skills] : defaultAiSkills,
  );
  const [aiStructure, setAiStructure] = useState<ProblemStructureId>(
    initialRunningJob?.problemStructure ?? 'multi_file',
  );
  const [aiWorkKind, setAiWorkKind] = useState<string>(
    initialRunningJob?.workKind ?? WORK_KIND_OPTIONS[0].id,
  );
  const [aiDomain, setAiDomain] = useState<string>(
    initialRunningJob?.domain ?? DOMAIN_OPTIONS[0].id,
  );
  const [aiDuration, setAiDuration] = useState<30 | 45 | 60 | 90>(
    initialRunningJob?.durationMinutes ?? 60,
  );
  const [aiIntegratedAi, setAiIntegratedAi] = useState<boolean>(
    initialRunningJob?.integratedAi ?? false,
  );
  const [aiGuidance, setAiGuidance] = useState<string>(
    initialRunningJob?.guidance ?? '',
  );
  const [aiSettingsOpen, setAiSettingsOpen] = useState<boolean>(false);
  const [activeGenJob, setActiveGenJob] =
    useState<BuilderGenerationJobView | null>(initialRunningJob);
  const [generating, setGenerating] = useState(hasInitialRunningJob);
  const [aiGenCompleting, setAiGenCompleting] = useState(false);
  const genSettleTimerRef = useRef<number | null>(null);
  const trackedRunningJobIdRef = useRef<string | null>(
    initialRunningJob?.jobId ?? null,
  );
  const acknowledgedJobIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    return () => {
      if (genSettleTimerRef.current !== null) {
        window.clearTimeout(genSettleTimerRef.current);
      }
    };
  }, []);

  const [libOwnerFilter, setLibOwnerFilter] = useState<'all' | 'mine'>('all');
  const [libSourceFilter, setLibSourceFilter] = useState<
    'all' | 'template' | 'ai_generated'
  >('all');
  const [libRoleFilter, setLibRoleFilter] = useState<string>('all');
  const [problemHealthMap, setProblemHealthMap] = useState<
    Record<string, OrgProblemHealthItem>
  >({});
  const [healthFetched, setHealthFetched] = useState(false);
  const builderUiStorageKey = `hirearchy:builder:ui:v1:${organizationId}`;
  const [uiHydrated, setUiHydrated] = useState(false);

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
  const [issuedResult, setIssuedResult] = useState<{
    candidateLink: string;
    recipient: string;
    expiresAt: string;
  } | null>(null);
  const issuedHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (issuedResult) issuedHeading.current?.focus();
  }, [issuedResult]);
  const [copyFallback, setCopyFallback] = useState<'link' | 'email' | null>(
    null,
  );
  const issuedLinkInput = useRef<HTMLInputElement>(null);

  const legacyDraftKey = `hirearchy:builder:state:v2:${organizationId}`;
  const draftPrefix = `hirearchy:builder:draft:${organizationId}:${currentPrincipalId}:`;
  const [activeDraftId, setActiveDraftId] = useState<string>();
  const [savedDrafts, setSavedDrafts] = useState<SavedBuilderDraft[]>([]);
  const builderDraftStorageKey =
    activeDraftId === 'legacy'
      ? legacyDraftKey
      : `${draftPrefix}${activeDraftId}`;

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      let drafts: SavedBuilderDraft[] = [];
      try {
        drafts = readSavedBuilderDrafts(legacyDraftKey, draftPrefix);
      } catch {
        // Browser storage may be unavailable.
      }
      setSavedDrafts(drafts);
      const id = fresh
        ? window.crypto.randomUUID()
        : (draftId ?? drafts[0]?.id ?? window.crypto.randomUUID());
      setActiveDraftId(id);
      const params = new URLSearchParams(window.location.search);
      const urlMode = params.get('mode');
      const urlStage = params.get('stage');

      const savedUi = readPersistedJson<{
        mode?: BuilderMode;
        aiSettingsOpen?: boolean;
        libOwnerFilter?: 'all' | 'mine';
        libSourceFilter?: 'all' | 'template' | 'ai_generated';
        libRoleFilter?: string;
      }>(builderUiStorageKey, 'durable');
      if (savedUi && typeof savedUi === 'object') {
        if (typeof savedUi.aiSettingsOpen === 'boolean') {
          setAiSettingsOpen(savedUi.aiSettingsOpen);
        }
        if (
          savedUi.libOwnerFilter === 'all' ||
          savedUi.libOwnerFilter === 'mine'
        ) {
          setLibOwnerFilter(savedUi.libOwnerFilter);
        }
        if (
          savedUi.libSourceFilter === 'all' ||
          savedUi.libSourceFilter === 'template' ||
          savedUi.libSourceFilter === 'ai_generated'
        ) {
          setLibSourceFilter(savedUi.libSourceFilter);
        }
        if (typeof savedUi.libRoleFilter === 'string') {
          setLibRoleFilter(savedUi.libRoleFilter);
        }
        if (
          !urlMode &&
          !hasInitialRunningJob &&
          (savedUi.mode === 'templates' ||
            savedUi.mode === 'ai' ||
            savedUi.mode === 'library')
        ) {
          setMode(savedUi.mode);
        }
      }
      setUiHydrated(true);

      if (fresh) {
        setIsHydrated(true);
        return;
      }
      const storageKey =
        id === 'legacy' ? legacyDraftKey : `${draftPrefix}${id}`;

      try {
        const saved =
          window.localStorage.getItem(storageKey) ??
          window.sessionStorage.getItem(storageKey);
        if (saved) {
          const parsed = JSON.parse(saved) as {
            completed?: boolean;
            mode?: BuilderMode;
            stage?: BuilderStage;
            previewTab?: PreviewTab;
            problemSelected?: boolean;
            previewVisited?: boolean;
            draft?: R211AssessmentDraftInput;
            meta?: typeof activeSourceMeta;
            savedIds?: {
              definitionId: string;
              validatedVersionId: string;
            } | null;
            previewFilePath?: string;
            tplDuration?: 30 | 45 | 60 | 90;
            tplIntegratedAi?: boolean;
            aiConfig?: {
              role?: string;
              expLevel?: ExperienceLevelId;
              years?: number;
              skills?: string[];
              structure?: ProblemStructureId;
              workKind?: string;
              domain?: string;
              duration?: 30 | 45 | 60 | 90;
              integratedAi?: boolean;
              guidance?: string;
            };
            inviteDraft?: {
              candidateEmail?: string;
              reviewerPrincipalId?: string;
              expiresInDays?: number;
              invitationNote?: string;
            };
          };

          setDraftCompleted(Boolean(parsed?.completed));
          const restoredSelected = Boolean(parsed?.problemSelected);
          setProblemSelected(restoredSelected);
          if (parsed?.previewVisited) {
            setPreviewVisited(true);
          }
          if (
            parsed?.draft &&
            parsed.draft.title &&
            parsed.draft.starterFiles &&
            restoredSelected
          ) {
            setActiveDraft(parsed.draft);
            setPreviewFilePath(
              parsed.previewFilePath || parsed.draft.primaryFilePath,
            );
          }
          if (parsed?.meta && restoredSelected) {
            setActiveSourceMeta(parsed.meta);
          }
          if (parsed?.savedIds !== undefined && restoredSelected) {
            setSavedIds(parsed.savedIds);
          }
          if (typeof parsed?.tplDuration === 'number') {
            setTplDuration(parsed.tplDuration);
          }
          if (typeof parsed?.tplIntegratedAi === 'boolean') {
            setTplIntegratedAi(parsed.tplIntegratedAi);
          }
          if (parsed?.aiConfig && !hasInitialRunningJob) {
            if (parsed.aiConfig.role) setAiRole(parsed.aiConfig.role);
            if (parsed.aiConfig.expLevel)
              setAiExpLevel(parsed.aiConfig.expLevel);
            if (typeof parsed.aiConfig.years === 'number') {
              setAiYears(parsed.aiConfig.years);
            }
            if (Array.isArray(parsed.aiConfig.skills)) {
              setAiSkills(parsed.aiConfig.skills);
            }
            if (parsed.aiConfig.structure) {
              setAiStructure(parsed.aiConfig.structure);
            }
            if (parsed.aiConfig.workKind)
              setAiWorkKind(parsed.aiConfig.workKind);
            if (parsed.aiConfig.domain) setAiDomain(parsed.aiConfig.domain);
            if (typeof parsed.aiConfig.duration === 'number') {
              setAiDuration(parsed.aiConfig.duration);
            }
            if (typeof parsed.aiConfig.integratedAi === 'boolean') {
              setAiIntegratedAi(parsed.aiConfig.integratedAi);
            }
            if (typeof parsed.aiConfig.guidance === 'string') {
              setAiGuidance(parsed.aiConfig.guidance);
            }
          }
          if (parsed?.inviteDraft) {
            if (typeof parsed.inviteDraft.candidateEmail === 'string') {
              setCandidateEmail(parsed.inviteDraft.candidateEmail);
            }
            if (typeof parsed.inviteDraft.reviewerPrincipalId === 'string') {
              setReviewerPrincipalId(parsed.inviteDraft.reviewerPrincipalId);
            }
            if (typeof parsed.inviteDraft.expiresInDays === 'number') {
              setExpiresInDays(parsed.inviteDraft.expiresInDays);
            }
            if (typeof parsed.inviteDraft.invitationNote === 'string') {
              setInvitationNote(parsed.inviteDraft.invitationNote);
            }
          }
          if (
            parsed?.previewTab === 'overview' ||
            parsed?.previewTab === 'repository' ||
            parsed?.previewTab === 'rubric'
          ) {
            setPreviewTab(parsed.previewTab);
          }

          if (!hasInitialRunningJob) {
            const requestedMode =
              urlMode === 'templates' ||
              urlMode === 'ai' ||
              urlMode === 'library'
                ? urlMode
                : parsed?.mode === 'templates' ||
                    parsed?.mode === 'ai' ||
                    parsed?.mode === 'library'
                  ? parsed.mode
                  : null;
            if (requestedMode) {
              setMode(requestedMode);
            }

            const requestedStage =
              urlStage === 'source' ||
              urlStage === 'preview' ||
              urlStage === 'invite'
                ? urlStage
                : parsed?.stage === 'source' ||
                    parsed?.stage === 'preview' ||
                    parsed?.stage === 'invite'
                  ? parsed.stage
                  : 'source';
            if (restoredSelected) {
              setStage(requestedStage);
              if (requestedStage === 'preview') setPreviewVisited(true);
            } else {
              setStage('source');
              if (requestedStage !== 'source') {
                setErrorBanner(
                  'Select a template, saved problem, or generate an assessment with AI before moving to Preview or Invite.',
                );
              }
            }
          } else {
            setMode('ai');
            setStage('source');
          }
        } else {
          if (
            !hasInitialRunningJob &&
            (urlMode === 'templates' ||
              urlMode === 'ai' ||
              urlMode === 'library')
          ) {
            setMode(urlMode);
          }
          setStage('source');
          if (
            !hasInitialRunningJob &&
            (urlStage === 'preview' || urlStage === 'invite')
          ) {
            setErrorBanner(
              'Select a template, saved problem, or generate an assessment with AI before moving to Preview or Invite.',
            );
          }
        }
      } catch {
        // Ignore storage errors
      }
      setIsHydrated(true);
    });
    return () => {
      active = false;
    };
  }, [
    builderUiStorageKey,
    draftId,
    draftPrefix,
    fresh,
    hasInitialRunningJob,
    legacyDraftKey,
  ]);

  useEffect(() => {
    if (!uiHydrated) return;
    writePersistedJson(
      builderUiStorageKey,
      {
        mode,
        aiSettingsOpen,
        libOwnerFilter,
        libSourceFilter,
        libRoleFilter,
      },
      'durable',
    );
  }, [
    aiSettingsOpen,
    builderUiStorageKey,
    libOwnerFilter,
    libRoleFilter,
    libSourceFilter,
    mode,
    uiHydrated,
  ]);

  useEffect(() => {
    if (!isHydrated || !activeDraftId) return;
    const url = new URL(window.location.href);
    url.searchParams.set('draft', activeDraftId);
    url.searchParams.set('mode', mode);
    url.searchParams.set('stage', stage);
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}`,
    );
  }, [activeDraftId, isHydrated, mode, stage]);

  useEffect(() => {
    if (!isHydrated) return;
    try {
      const draftState = {
        updatedAt: new Date().toISOString(),
        completed:
          Boolean(issuedResult) || (draftCompleted && !candidateEmail.trim()),
        mode,
        stage,
        previewTab,
        problemSelected,
        previewVisited,
        draft: activeDraft,
        meta: activeSourceMeta,
        savedIds,
        previewFilePath,
        tplDuration,
        tplIntegratedAi,
        aiConfig: {
          role: aiRole,
          expLevel: aiExpLevel,
          years: aiYears,
          skills: aiSkills,
          structure: aiStructure,
          workKind: aiWorkKind,
          domain: aiDomain,
          duration: aiDuration,
          integratedAi: aiIntegratedAi,
          guidance: aiGuidance,
        },
        inviteDraft: {
          candidateEmail,
          reviewerPrincipalId,
          expiresInDays,
          invitationNote,
        },
      };
      if (!hasBuilderDraftContent(draftState)) {
        window.localStorage.removeItem(builderDraftStorageKey);
        window.sessionStorage.removeItem(builderDraftStorageKey);
        return;
      }
      const payload = JSON.stringify(draftState);
      window.localStorage.setItem(builderDraftStorageKey, payload);
      window.sessionStorage.setItem(builderDraftStorageKey, payload);
    } catch {
      // Ignore storage errors
    }
  }, [
    isHydrated,
    builderDraftStorageKey,
    issuedResult,
    draftCompleted,
    mode,
    stage,
    previewTab,
    problemSelected,
    previewVisited,
    activeDraft,
    activeSourceMeta,
    savedIds,
    previewFilePath,
    tplDuration,
    tplIntegratedAi,
    aiRole,
    aiExpLevel,
    aiYears,
    aiSkills,
    aiStructure,
    aiWorkKind,
    aiDomain,
    aiDuration,
    aiIntegratedAi,
    aiGuidance,
    candidateEmail,
    reviewerPrincipalId,
    expiresInDays,
    invitationNote,
  ]);

  const builderGenerateApiUrl = `/r23/api/organizations/${encodeURIComponent(organizationId)}/hiring/builder/generate`;

  useEffect(() => {
    if (mode !== 'library' || healthFetched || typeof fetch !== 'function') {
      return;
    }
    let active = true;
    fetch(
      `/r23/api/organizations/${encodeURIComponent(organizationId)}/hiring/health`,
      { headers: { Accept: 'application/json' }, cache: 'no-store' },
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { problems?: OrgProblemHealthItem[] } | null) => {
        if (!active) return;
        setHealthFetched(true);
        if (Array.isArray(data?.problems)) {
          const map: Record<string, OrgProblemHealthItem> = {};
          for (const item of data.problems) {
            map[item.definitionId] = item;
          }
          setProblemHealthMap(map);
        }
      })
      .catch(() => {
        if (active) setHealthFetched(true);
      });
    return () => {
      active = false;
    };
  }, [healthFetched, mode, organizationId]);

  const acknowledgeGenJob = useCallback(
    (jobId: string) => {
      acknowledgedJobIdsRef.current.add(jobId);
      const csrf = readCsrfCookie();
      void fetch(
        `${builderGenerateApiUrl}?jobId=${encodeURIComponent(jobId)}`,
        {
          method: 'DELETE',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            ...(csrf ? { 'x-csrf-token': csrf } : {}),
          },
        },
      ).catch(() => null);
    },
    [builderGenerateApiUrl],
  );

  useEffect(() => {
    let active = true;
    const syncJob = (job: BuilderGenerationJobView) => {
      if (!active) return;
      if (job.status === 'running') {
        const isFirstAttach = trackedRunningJobIdRef.current !== job.jobId;
        trackedRunningJobIdRef.current = job.jobId;
        setActiveGenJob(job);
        setGenerating(true);
        if (isFirstAttach) {
          setAiRole(job.targetRole);
          setAiExpLevel(job.experienceLevel);
          setAiYears(job.yearsExperience);
          setAiSkills([...job.skills]);
          setAiStructure(job.problemStructure);
          setAiWorkKind(job.workKind);
          setAiDomain(job.domain);
          setAiDuration(job.durationMinutes);
          setAiIntegratedAi(job.integratedAi);
          setAiGuidance(job.guidance ?? '');
          setMode('ai');
          setStage('source');
        }
        return;
      }
      if (acknowledgedJobIdsRef.current.has(job.jobId)) {
        return;
      }
      trackedRunningJobIdRef.current = null;
      setActiveGenJob(null);
      if (job.status === 'completed' && job.draft) {
        const completedDraft = job.draft;
        setActiveDraft(completedDraft);
        setActiveSourceMeta({
          sourceKind: 'ai_generated',
          targetRole: job.targetRole,
          experienceLevel: job.experienceLevel,
          yearsExperience: job.yearsExperience,
          skills: job.skills,
          problemStructure: job.problemStructure,
          workKind: job.workKind,
          domain: job.domain,
          generationBrief: {
            workKind: job.workKind,
            domain: job.domain,
            guidance: job.guidance,
            modelId: job.modelId,
          },
        });
        setAiRole(job.targetRole);
        setAiExpLevel(job.experienceLevel);
        setAiYears(job.yearsExperience);
        setAiSkills([...job.skills]);
        setAiStructure(job.problemStructure);
        setAiWorkKind(job.workKind);
        setAiDomain(job.domain);
        setAiDuration(job.durationMinutes);
        setAiIntegratedAi(job.integratedAi);
        setAiGuidance(job.guidance ?? '');
        setProblemSelected(true);
        setPreviewVisited(true);
        setSavedIds(null);
        setPreviewFilePath(completedDraft.primaryFilePath);
        acknowledgeGenJob(job.jobId);
        setGenerating(false);
        setAiGenCompleting(true);
        if (genSettleTimerRef.current !== null) {
          window.clearTimeout(genSettleTimerRef.current);
        }
        genSettleTimerRef.current = window.setTimeout(() => {
          genSettleTimerRef.current = null;
          setAiGenCompleting(false);
          setStage('preview');
          emitToast({
            message: `Generated "${completedDraft.title}". Review it below, save to your role library, or invite a candidate.`,
            tone: 'success',
          });
        }, 280);
        return;
      }
      setGenerating(false);
      if (job.status === 'failed') {
        setErrorBanner(job.error ?? 'Unable to generate assessment with AI.');
        acknowledgeGenJob(job.jobId);
      }
    };

    const pollOnce = async () => {
      try {
        const res = await fetch(builderGenerateApiUrl, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        if (!res.ok || !active) return;
        const data = (await res.json().catch(() => null)) as {
          job?: BuilderGenerationJobView | null;
        } | null;
        if (!active || !data || typeof data !== 'object' || !('job' in data)) {
          return;
        }
        if (data.job && typeof data.job === 'object' && data.job.jobId) {
          syncJob(data.job);
        } else if (
          data.job === null &&
          trackedRunningJobIdRef.current !== null
        ) {
          trackedRunningJobIdRef.current = null;
          setActiveGenJob(null);
          setGenerating(false);
          setErrorBanner(
            'The background generation job was interrupted. Click Generate assessment with AI to try again.',
          );
        }
      } catch {
        // Non-blocking
      }
    };

    if (initialGenerationJob && initialGenerationJob.status !== 'running') {
      queueMicrotask(() => {
        if (active) {
          syncJob(initialGenerationJob);
        }
      });
    } else {
      void pollOnce();
    }
    const timer =
      activeGenJob?.status === 'running'
        ? window.setInterval(() => void pollOnce(), 2000)
        : undefined;
    return () => {
      active = false;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [
    acknowledgeGenJob,
    activeGenJob?.jobId,
    activeGenJob?.status,
    builderGenerateApiUrl,
    initialGenerationJob,
  ]);

  const orgBase = `/r23/organizations/${encodeURIComponent(organizationId)}`;
  const canUseAiBuilder = hasPlanFeature(plan.planTier, 'aiAssessmentBuilder');
  const builderHref = `${orgBase}/builder`;
  const resumableDrafts = savedDrafts.filter(({ id }) => id !== activeDraftId);
  const trimmedEmail = candidateEmail.trim().toLowerCase();
  const alreadyCreditedCandidate =
    trimmedEmail.length > 0 && plan.creditedEmails.includes(trimmedEmail);
  const creditsBlocked =
    plan.planTier === 'none' ||
    (plan.planTier === 'per_candidate' &&
      (plan.candidateCreditsRemaining ?? 0) <= 0 &&
      !alreadyCreditedCandidate);

  const libraryGroups = useMemo(() => {
    const filtered = library.filter((item) => {
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
    const groups = new Map<string, SavedLibraryProblem[]>();
    for (const problem of filtered) {
      const key =
        problem.sourceKind === 'template' && problem.templateId
          ? `template:${problem.templateId}`
          : problem.definitionId;
      const versions = groups.get(key) ?? [];
      versions.push(problem);
      groups.set(key, versions);
    }
    return [...groups];
  }, [
    library,
    libOwnerFilter,
    libSourceFilter,
    libRoleFilter,
    currentPrincipalId,
  ]);

  const selectTemplate = (tpl: PlatformTemplateView) => {
    trackClientEvent({
      eventName: 'builder.template.selected',
      category: 'team_funnel',
      actorType: 'team_member',
      organizationId,
      principalId: currentPrincipalId,
      planTier: plan.planTier,
      properties: {
        templateId: tpl.templateId,
        targetRole: tpl.targetRole,
        experienceLevel: tpl.experienceLevel,
      },
    });
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
    setProblemSelected(true);
    setPreviewVisited(true);
    setSavedIds(null);
    setPreviewFilePath(nextDraft.primaryFilePath);
    setIssuedResult(null);
    setErrorBanner(null);
    showStage('preview');
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
    setProblemSelected(true);
    setPreviewVisited(true);
    setSavedIds({
      definitionId: problem.definitionId,
      validatedVersionId: problem.validatedVersionId,
    });
    setPreviewFilePath(nextDraft.primaryFilePath);
    setIssuedResult(null);
    setErrorBanner(null);
    emitToast({
      message: `Loaded "${problem.title}" from your Saved Problem Library.`,
      tone: 'info',
    });
    showStage('preview');
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

  const completeAiGenerationWithSettle = (onSettled: () => void) => {
    setGenerating(false);
    setAiGenCompleting(true);
    if (genSettleTimerRef.current !== null) {
      window.clearTimeout(genSettleTimerRef.current);
    }
    genSettleTimerRef.current = window.setTimeout(() => {
      genSettleTimerRef.current = null;
      setAiGenCompleting(false);
      onSettled();
    }, 280);
  };

  const handleGenerateAi = async () => {
    setErrorBanner(null);
    setIssuedResult(null);
    setAiGenCompleting(false);
    setGenerating(true);
    try {
      const csrf = readCsrfCookie();
      const response = await fetch(builderGenerateApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify({
          csrf,
          async: true,
          draftId: activeDraftId,
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
      });
      const data = (await response.json().catch(() => null)) as {
        draft?: R211AssessmentDraftInput;
        modelId?: string;
        job?: BuilderGenerationJobView;
        error?: { message?: string };
      } | null;

      if (!response.ok || (!data?.draft && !data?.job)) {
        const message = data?.error?.message;
        throw new Error(
          response.status === 503 && /timeout|timed out/i.test(message ?? '')
            ? 'AI generation timed out. Try again or start from a template.'
            : (message ??
                `Unable to generate assessment (HTTP ${response.status}).`),
        );
      }

      if (data.job && data.job.jobId) {
        if (data.job.status === 'running') {
          trackedRunningJobIdRef.current = data.job.jobId;
          setActiveGenJob(data.job);
          return;
        }
        trackedRunningJobIdRef.current = null;
        if (data.job.status === 'failed') {
          acknowledgeGenJob(data.job.jobId);
          throw new Error(
            data.job.error ?? 'Unable to generate assessment with AI.',
          );
        }
        if (data.job.draft) {
          const generatedDraft = data.job.draft;
          setActiveDraft(generatedDraft);
          setActiveSourceMeta({
            sourceKind: 'ai_generated',
            targetRole: data.job.targetRole,
            experienceLevel: data.job.experienceLevel,
            yearsExperience: data.job.yearsExperience,
            skills: data.job.skills,
            problemStructure: data.job.problemStructure,
            workKind: data.job.workKind,
            domain: data.job.domain,
            generationBrief: {
              workKind: data.job.workKind,
              domain: data.job.domain,
              guidance: data.job.guidance,
              modelId: data.job.modelId,
            },
          });
          setProblemSelected(true);
          setPreviewVisited(true);
          setSavedIds(null);
          setPreviewFilePath(generatedDraft.primaryFilePath);
          setActiveGenJob(null);
          acknowledgeGenJob(data.job.jobId);
          completeAiGenerationWithSettle(() => {
            showStage('preview');
            emitToast({
              message: `Generated "${generatedDraft.title}". Review it below, save to your role library, or invite a candidate.`,
              tone: 'success',
            });
          });
          return;
        }
      }

      if (data.draft) {
        const generatedDraft = data.draft;
        setActiveDraft(generatedDraft);
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
        setProblemSelected(true);
        setPreviewVisited(true);
        setSavedIds(null);
        setPreviewFilePath(generatedDraft.primaryFilePath);
        completeAiGenerationWithSettle(() => {
          showStage('preview');
          emitToast({
            message: `Generated "${generatedDraft.title}". Review it below, save to your role library, or invite a candidate.`,
            tone: 'success',
          });
        });
      }
    } catch (err) {
      setGenerating(false);
      setActiveGenJob(null);
      setErrorBanner(
        err instanceof Error
          ? err.message
          : 'Unable to generate assessment with AI.',
      );
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
    setSavingLibrary(true);
    try {
      await ensureSavedToLibrary();

      emitToast({
        message: `Saved "${activeDraft.title}" to your organization's Problem Library.`,
        tone: 'success',
      });
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
    if (issuing || issuedResult) return;
    setErrorBanner(null);
    setCopyFallback(null);

    if (!problemSelected) {
      setErrorBanner(
        'Select or generate an assessment problem before sending an invitation.',
      );
      setStage('source');
      return;
    }

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
        candidateLink: data.candidateLink,
        recipient: trimmedEmail,
        expiresAt: data.expiresAt ?? '',
      });
      setCandidateEmail('');
      setInvitationNote('');

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
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : 'Unable to issue assessment.',
      );
    } finally {
      setIssuing(false);
    }
  };

  const invitationUrl = issuedResult
    ? new URL(issuedResult.candidateLink, window.location.origin).href
    : '';
  const aiRuleCopy = activeDraft.integratedAi
    ? 'Workspace AI assistant: enabled (prompts are logged neutrally; AI rules are shown upfront before you begin).'
    : 'Workspace AI assistant: disabled for this task (AI rules are shown upfront before you begin).';
  const invitationEmail = `Hi,\n\nYou’ve been invited to complete the "${activeDraft.title}" engineering assessment.\n\n• Time budget: ${activeDraft.durationMinutes} min (your timer starts only after clicking Start)\n• Real codebase editor: zero webcam, microphone, or desktop spyware\n• ${aiRuleCopy}\n• Permanent read-only receipt: you keep a copy of your submitted code after submission\n\nOpen your workspace link below whenever you’re ready:\n${invitationUrl}\n\nBest regards,\nThe Hiring Team`;

  const resetForAnotherCandidate = () => {
    setCandidateEmail('');
    setInvitationNote('');
    setIssuedResult(null);
    setDraftCompleted(false);
    setErrorBanner(null);
    setCopyFallback(null);
  };

  const renderLibraryVersion = (problem: SavedLibraryProblem) => {
    const isSelected =
      problemSelected && savedIds?.definitionId === problem.definitionId;
    const health = problemHealthMap[problem.definitionId];
    const healthMeta = health ? healthFlagMeta(health.healthFlag) : null;
    return (
      <div
        key={problem.definitionId}
        className={`software-problem-row${isSelected ? ' is-selected' : ''}`}
      >
        <div className="hiring-stack-xs">
          <div className="hiring-chip-group">
            <span className="hiring-pill hiring-pill-plum">
              {problem.sourceKind === 'template' ? 'Template' : 'AI generated'}
            </span>
            <span className="hiring-pill">
              {problem.targetRole || 'General'}
            </span>
            <span className="hiring-pill">Issued {problem.issuedCount}×</span>
            {healthMeta ? (
              <span className={healthMeta.pillClass}>{healthMeta.label}</span>
            ) : null}
          </div>
          <p className="hiring-muted-copy">
            By {problem.authorName} · {problem.durationMinutes} min ·{' '}
            {experienceLevelLabel(problem.experienceLevel)}
          </p>
          <p className="hiring-muted-copy">
            AI {problem.integratedAi ? 'on' : 'off'} · Terminal{' '}
            {problem.terminalEnabled ? 'on' : 'off'}
            {' · Saved '}
            <LocalTime timestamp={problem.createdAt} absolute />
          </p>
          {health && health.started > 0 ? (
            <p className="hiring-muted-copy">
              {health.completionRatePct}% completion
              {health.medianMinutes !== null
                ? ` · ${health.medianMinutes}m median`
                : ''}
              {health.executionErrorRatePct > 0
                ? ` · ${health.executionErrorRatePct}% runner errors`
                : ''}
              {health.avgCandidateRating !== null
                ? ` · ${health.avgCandidateRating.toFixed(1)}★`
                : ''}
            </p>
          ) : null}
          {health?.diagnosticHint ? (
            <p className="hiring-muted-copy org-problem-diagnostic-hint">
              {health.diagnosticHint}
            </p>
          ) : null}
        </div>
        <div className="hiring-header-actions">
          {healthMeta?.isAlert ? (
            <button
              type="button"
              className="hiring-btn hiring-btn-sm"
              onClick={() => selectSavedProblem(problem)}
            >
              Customize / adjust
            </button>
          ) : null}
          <button
            type="button"
            className={`hiring-btn${isSelected ? ' hiring-btn-primary' : ''}`}
            onClick={() => selectSavedProblem(problem)}
          >
            Preview saved problem{' '}
            <IconArrowRight size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  };

  const selectedStructureOption =
    PROBLEM_STRUCTURE_OPTIONS.find((opt) => opt.id === aiStructure) ??
    PROBLEM_STRUCTURE_OPTIONS[0];
  const selectedDomainOption =
    DOMAIN_OPTIONS.find((dom) => dom.id === aiDomain) ?? DOMAIN_OPTIONS[0];
  const editableTemplate =
    activeSourceMeta.sourceKind === 'template' && !savedIds;

  const stages = [
    {
      id: 'source',
      title: 'Problem',
      statusBadge: problemSelected ? 'Problem selected' : null,
    },
    {
      id: 'preview',
      title: 'Preview',
      statusBadge: problemSelected && previewVisited ? 'Preview ready' : null,
    },
    {
      id: 'invite',
      title: 'Invite',
      statusBadge: issuedResult ? 'Issued' : null,
    },
  ] as const;

  return (
    <div className="software-builder-flow" ref={builderFlow}>
      <aside className="team-builder-rail" aria-label="Builder navigation">
        <nav
          className="software-builder-stages"
          aria-label="Assessment builder steps"
        >
          <ol>
            {stages.map((item, index) => {
              const locked =
                issuing ||
                (issuedResult
                  ? item.id !== 'invite'
                  : !problemSelected && item.id !== 'source');
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    id={`builder-stage-${item.id}`}
                    aria-current={stage === item.id ? 'step' : undefined}
                    aria-label={
                      item.statusBadge
                        ? `${item.title}, ${item.statusBadge}`
                        : undefined
                    }
                    disabled={locked}
                    onClick={() => goToStage(item.id)}
                  >
                    <span
                      className="team-builder-step-index"
                      data-complete={Boolean(item.statusBadge)}
                      aria-hidden="true"
                    >
                      {item.statusBadge ? (
                        <IconCheck size={14} stroke={2.5} />
                      ) : (
                        index + 1
                      )}
                    </span>
                    <span>{item.title}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        <div className="team-builder-drafts">
          <a
            className="hiring-btn hiring-btn-sm"
            href={`${builderHref}?mode=new`}
          >
            <IconPlus size={16} aria-hidden="true" />
            New assessment
          </a>
          {resumableDrafts.length > 0 ? (
            <details className="hiring-disclosure">
              <summary>Resume draft ({resumableDrafts.length})</summary>
              <ul className="hiring-stack-xs hiring-bullet-list">
                {resumableDrafts.map(({ id, title, updatedAt }) => (
                  <li key={id}>
                    <a href={`${builderHref}?draft=${id}`}>{title}</a>
                    {updatedAt ? (
                      <>
                        {' '}
                        · <LocalTime timestamp={updatedAt} />
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </aside>
      <div className="software-builder-content">
        {errorBanner ? (
          <div className="hiring-banner hiring-banner-danger" role="alert">
            {errorBanner}
          </div>
        ) : null}

        {stage === 'invite' && !issuedResult && creditsBlocked ? (
          <div className="hiring-banner hiring-banner-warning" role="alert">
            <div>
              <strong>
                {plan.planTier === 'none'
                  ? 'Active plan required:'
                  : 'No candidate slots remaining:'}
              </strong>{' '}
              {plan.planTier === 'none'
                ? 'Choose an organization plan to issue assessments.'
                : `Used ${plan.candidateCreditsUsed}/${plan.candidateCreditsPurchased} purchased candidate slots. Add slots or upgrade to Pro/Ultra.`}
            </div>
            <a className="hiring-btn hiring-btn-sm" href={`${orgBase}/plan`}>
              View organization plan
            </a>
          </div>
        ) : null}

        <section
          id="problem-source"
          hidden={stage !== 'source'}
          className="software-builder-stage hiring-card"
        >
          <div className="team-builder-source-heading">
            <h2>Choose a problem</h2>
            <HorizontalTabs<BuilderMode>
              id="builder-source"
              label="Assessment source mode"
              active={mode}
              onSelect={(nextMode) => {
                setMode(nextMode);
                trackClientEvent({
                  eventName: 'builder.mode.selected',
                  category: 'team_funnel',
                  actorType: 'team_member',
                  organizationId,
                  principalId: currentPrincipalId,
                  planTier: plan.planTier,
                  properties: { mode: nextMode },
                });
              }}
              className="hiring-builder-tabs"
              tabClassName="hiring-builder-tab"
              tabs={[
                {
                  id: 'templates',
                  label: (
                    <>
                      <IconTemplate size={16} /> Templates
                    </>
                  ),
                },
                {
                  id: 'ai',
                  label: (
                    <>
                      <IconCodePlus size={16} aria-hidden="true" /> Generate
                      with AI
                    </>
                  ),
                  ariaLabel: 'Generate with AI',
                },
                {
                  id: 'library',
                  label: (
                    <>
                      <IconBookmark size={16} /> Library
                    </>
                  ),
                  ariaLabel: 'Problem library',
                },
              ]}
            />
          </div>
          {mode === 'templates' ? (
            <div
              className="hiring-builder-pane hiring-template-picker"
              id="builder-source-panel"
              role="tabpanel"
              aria-labelledby="builder-source-templates"
              tabIndex={0}
            >
              <div className="hiring-template-library">
                <div className="software-problem-list">
                  {initialTemplates.map((tpl) => {
                    const selected =
                      problemSelected &&
                      activeSourceMeta.sourceKind === 'template' &&
                      activeDraft.templateId === tpl.templateId;
                    return (
                      <article
                        key={tpl.templateId}
                        className={`software-problem-row${selected ? ' is-selected' : ''}`}
                      >
                        <div className="hiring-stack-xs">
                          <h3>{tpl.title}</h3>
                          <p className="hiring-muted-copy">{tpl.summary}</p>
                          <p className="hiring-candidate-meta">
                            {tpl.targetRole} ·{' '}
                            {experienceLevelLabel(tpl.experienceLevel)} ·{' '}
                            {tpl.problemStructure === 'multi_file'
                              ? 'Multi-file repository'
                              : 'Single-module problem'}
                          </p>
                        </div>
                        <button
                          type="button"
                          className={`hiring-btn${selected ? ' hiring-btn-primary' : ''}`}
                          onClick={() => selectTemplate(tpl)}
                        >
                          {selected ? 'Selected · Preview' : 'Preview template'}{' '}
                          <IconArrowRight size={15} aria-hidden="true" />
                        </button>
                      </article>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : null}

          {mode === 'ai' ? (
            <div
              className="hiring-builder-pane"
              id="builder-source-panel"
              role="tabpanel"
              aria-labelledby="builder-source-ai"
              tabIndex={0}
            >
              {!canUseAiBuilder ? (
                <div className="hiring-banner hiring-banner-warning">
                  <div>
                    <strong>Active paid plan required:</strong> Activate Per
                    Candidate, Pro, or Ultra in Team &amp; Plan to unlock AI
                    problem generation.
                  </div>
                  <a
                    className="hiring-btn hiring-btn-sm"
                    href={`${orgBase}/plan`}
                  >
                    Choose Plan
                  </a>
                </div>
              ) : null}

              <div className="hiring-ai-studio">
                <div className="hiring-generate-primary-grid">
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

                  <div className="hiring-field hiring-generate-focus-field">
                    <label htmlFor="ai-work-kind">Task focus</label>
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
                </div>

                <div className="hiring-ai-quick-bar">
                  <div className="hiring-field hiring-ai-quick-duration">
                    <label htmlFor="ai-duration">Time limit</label>
                    <select
                      id="ai-duration"
                      value={aiDuration}
                      onChange={(e) =>
                        setAiDuration(
                          Number(e.target.value) as 30 | 45 | 60 | 90,
                        )
                      }
                    >
                      <option value={30}>30 min</option>
                      <option value={45}>45 min</option>
                      <option value={60}>60 min</option>
                      <option value={90}>90 min</option>
                    </select>
                  </div>

                  <div className="hiring-field hiring-ai-quick-toggle">
                    <label className="hiring-switch-row">
                      <input
                        type="checkbox"
                        className="hiring-switch-input"
                        aria-label="Candidate AI assistant"
                        checked={aiIntegratedAi}
                        onChange={(e) => setAiIntegratedAi(e.target.checked)}
                      />
                      <span
                        className="hiring-switch-track"
                        aria-hidden="true"
                      />
                      <span className="hiring-switch-copy">
                        Candidate AI assistant
                      </span>
                    </label>
                    <span
                      className={`hiring-pill ${aiIntegratedAi ? 'hiring-pill-mint' : ''}`}
                    >
                      {aiIntegratedAi ? 'AI assistant on' : 'AI assistant off'}{' '}
                      · {aiDuration} min
                    </span>
                  </div>
                </div>

                <details
                  className="hiring-customize-details"
                  open={aiSettingsOpen}
                  onToggle={(e) => setAiSettingsOpen(e.currentTarget.open)}
                >
                  <summary>
                    <span>Additional constraints &amp; skills</span>
                    <small>
                      {selectedDomainOption.label} · {aiYears} yrs ·{' '}
                      {selectedStructureOption.label} · {aiSkills.length} skills
                    </small>
                  </summary>
                  <div className="hiring-customize-body">
                    <div className="hiring-generate-primary-grid">
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
                        <label htmlFor="ai-structure">
                          Repository structure
                        </label>
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
                        <p className="hiring-field-hint">
                          {selectedStructureOption.description}
                        </p>
                      </div>
                    </div>

                    <div className="hiring-field">
                      <span className="hiring-field-label">
                        Priority skills to test ({aiSkills.length} selected)
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

                    <div className="hiring-field">
                      <label htmlFor="ai-guidance">
                        Optional role focus note
                      </label>
                      <textarea
                        id="ai-guidance"
                        value={aiGuidance}
                        onChange={(e) => setAiGuidance(e.target.value)}
                        placeholder="Optional context or edge cases to focus on (e.g. idempotency, retries, timezone math)..."
                      />
                    </div>
                  </div>
                </details>

                <div className="hiring-header-actions">
                  <button
                    type="button"
                    className="hiring-btn hiring-btn-primary"
                    disabled={generating || aiGenCompleting || !canUseAiBuilder}
                    onClick={handleGenerateAi}
                  >
                    <IconCodePlus size={16} aria-hidden="true" />{' '}
                    {generating
                      ? 'Generating assessment…'
                      : aiGenCompleting
                        ? 'Opening preview…'
                        : 'Generate assessment with AI'}
                  </button>
                </div>
                {generating || aiGenCompleting ? (
                  <HirearchyAiThinking
                    variant="studio"
                    status={generating ? 'active' : 'completing'}
                    headline={
                      generating
                        ? 'Generating tailored assessment'
                        : 'Assessment ready — opening preview'
                    }
                    sublabel="Building starter repository, brief, and rubric — you can navigate elsewhere and return without losing progress."
                    startedAt={activeGenJob?.startedAt}
                    steps={[
                      { id: 'rubric', label: 'Analyzing role & constraints…' },
                      {
                        id: 'repo',
                        label: 'Designing repository files & tests…',
                      },
                      {
                        id: 'validate',
                        label: 'Validating rubric & test harness…',
                      },
                    ]}
                  />
                ) : null}
              </div>
            </div>
          ) : null}

          {mode === 'library' ? (
            <div
              className="hiring-builder-pane"
              id="builder-source-panel"
              role="tabpanel"
              aria-labelledby="builder-source-library"
              tabIndex={0}
            >
              <div className="hiring-filter-grid hiring-library-filters">
                <div className="hiring-field">
                  <label htmlFor="lib-owner">Authored by</label>
                  <select
                    id="lib-owner"
                    value={libOwnerFilter}
                    onChange={(e) =>
                      setLibOwnerFilter(e.target.value as 'all' | 'mine')
                    }
                  >
                    <option value="all">Anyone</option>
                    <option value="mine">Me</option>
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
                    <option value="ai_generated">AI Generated</option>
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

              {libraryGroups.length > 0 ? (
                <div className="software-problem-list">
                  {libraryGroups.map(([key, versions]) => {
                    const latest = versions[0];
                    return (
                      <article key={key} className="hiring-library-problem">
                        <h3>{latest.title}</h3>
                        {renderLibraryVersion(latest)}
                        {versions.length > 1 ? (
                          <details className="hiring-disclosure">
                            <summary>
                              {versions.length - 1} other saved{' '}
                              {versions.length === 2 ? 'version' : 'versions'}
                            </summary>
                            <div className="software-problem-list">
                              {versions.slice(1).map(renderLibraryVersion)}
                            </div>
                          </details>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              ) : library.length > 0 ? (
                <div className="hiring-stack-xs">
                  <p className="hiring-muted-copy" role="status">
                    No saved problems match these filters.
                  </p>
                  <div>
                    <button
                      type="button"
                      className="hiring-btn hiring-btn-sm"
                      onClick={() => {
                        setLibOwnerFilter('all');
                        setLibSourceFilter('all');
                        setLibRoleFilter('all');
                      }}
                    >
                      Clear filters
                    </button>
                  </div>
                </div>
              ) : (
                <div className="hiring-stack-xs">
                  <p className="hiring-muted-copy">
                    Your team has no saved problems yet.
                  </p>
                  <div>
                    <button
                      type="button"
                      className="hiring-btn hiring-btn-sm"
                      onClick={() => {
                        setMode('templates');
                        document
                          .getElementById('builder-source-templates')
                          ?.focus();
                      }}
                    >
                      Browse templates
                    </button>
                  </div>
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
              <h2>{activeDraft.title}</h2>
              <p className="hiring-muted-copy">
                {activeSourceMeta.targetRole} ·{' '}
                {experienceLevelLabel(activeSourceMeta.experienceLevel)}
                {editableTemplate
                  ? null
                  : ` · ${activeDraft.durationMinutes} min · Candidate AI assistant ${activeDraft.integratedAi ? 'on' : 'off'}`}
              </p>
            </div>
            <div className="hiring-header-actions hiring-preview-header-actions">
              <Link
                className="hiring-btn hiring-btn-sm"
                href={`${orgBase}/builder/candidate-preview${activeDraftId ? `?draft=${encodeURIComponent(activeDraftId)}` : ''}`}
                onClick={() => {
                  try {
                    window.sessionStorage.setItem(
                      `${CANDIDATE_PREVIEW_DRAFT_KEY_PREFIX}${organizationId}`,
                      JSON.stringify({ draft: activeDraft }),
                    );
                  } catch {
                    // Ignore storage failures in restricted contexts.
                  }
                }}
              >
                <IconEye size={16} aria-hidden="true" /> Preview as Candidate
              </Link>
              <button
                type="button"
                className="hiring-btn hiring-btn-sm"
                disabled={savingLibrary || Boolean(savedIds)}
                onClick={handleSaveLibraryOnly}
              >
                <IconBookmark size={16} />{' '}
                {savedIds
                  ? 'Saved to library'
                  : savingLibrary
                    ? 'Saving…'
                    : activeSourceMeta.sourceKind === 'ai_generated'
                      ? 'Save to role library'
                      : 'Save to library'}
              </button>
              <button
                type="button"
                className="hiring-btn hiring-btn-primary hiring-btn-sm"
                onClick={() => goToStage('invite')}
              >
                Continue to invitation{' '}
                <IconArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
          </header>
          {editableTemplate ? (
            <div className="hiring-template-settings">
              <div className="hiring-field">
                <label htmlFor="tpl-duration">Time limit</label>
                <select
                  id="tpl-duration"
                  value={tplDuration}
                  onChange={(e) => {
                    const next = Number(e.target.value) as 30 | 45 | 60 | 90;
                    setTplDuration(next);
                    if (activeSourceMeta.sourceKind === 'template') {
                      setActiveDraft((prev) => ({
                        ...prev,
                        durationMinutes: next,
                      }));
                    }
                  }}
                >
                  <option value={30}>30 min</option>
                  <option value={45}>45 min</option>
                  <option value={60}>60 min</option>
                  <option value={90}>90 min</option>
                </select>
              </div>
              <div className="hiring-field">
                <label className="hiring-switch-row">
                  <input
                    type="checkbox"
                    className="hiring-switch-input"
                    aria-label="Candidate AI assistant"
                    checked={tplIntegratedAi}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setTplIntegratedAi(checked);
                      if (activeSourceMeta.sourceKind === 'template') {
                        setActiveDraft((prev) => ({
                          ...prev,
                          integratedAi: checked,
                        }));
                      }
                    }}
                  />
                  <span className="hiring-switch-track" aria-hidden="true" />
                  <span className="hiring-switch-copy">
                    Candidate AI assistant
                  </span>
                </label>
              </div>
            </div>
          ) : null}
          {activeSourceMeta.sourceKind === 'ai_generated' ? (
            <p className="hiring-muted-copy">
              Review the starter files, acceptance criteria, and rubric, then
              save to your role library so future candidates receive the same
              calibrated task.
            </p>
          ) : null}
          <HorizontalTabs<PreviewTab>
            id="builder-preview"
            label="Candidate preview"
            active={previewTab}
            onSelect={setPreviewTab}
            className="hiring-preview-subtabs"
            tabClassName="hiring-preview-subtab"
            tabs={[
              { id: 'overview', label: 'Brief & criteria' },
              { id: 'repository', label: 'Repository files' },
              { id: 'rubric', label: 'Rubric' },
            ]}
          />
          {previewTab === 'overview' ? (
            <div
              className="hiring-preview-panel"
              id="builder-preview-panel"
              role="tabpanel"
              aria-labelledby="builder-preview-overview"
              tabIndex={0}
            >
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
            <div
              className="hiring-preview-panel"
              id="builder-preview-panel"
              role="tabpanel"
              aria-labelledby="builder-preview-rubric"
              tabIndex={0}
            >
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
            <div
              className="software-repo-preview"
              id="builder-preview-panel"
              role="tabpanel"
              aria-labelledby="builder-preview-repository"
              tabIndex={0}
            >
              <RepositoryInspector
                files={activeDraft.starterFiles}
                workspaceName="Starter repository"
                activePath={previewFilePath}
                onSelectPath={setPreviewFilePath}
              />
            </div>
          )}
          {activeSourceMeta.sourceKind === 'ai_generated' ? (
            <ProductFeedbackPulse
              surface="builder_ai_generated"
              actorType="team_member"
              organizationId={organizationId}
              storageKey={`hirearchy:fb:builder:${activeDraftId ?? activeDraft.title}`}
              title="How ready was this AI-generated assessment?"
              tags={[
                'Ready to send',
                'Needed minor edits',
                'Wrong difficulty',
                'Off-topic',
                'Great rubric',
              ]}
              context={{
                targetRole: activeSourceMeta.targetRole,
                experienceLevel: activeSourceMeta.experienceLevel,
                problemStructure: activeSourceMeta.problemStructure,
                durationMinutes: activeDraft.durationMinutes,
              }}
            />
          ) : null}
          <footer className="hiring-preview-footer">
            <button
              type="button"
              className="hiring-btn hiring-btn-sm"
              onClick={() => goToStage('source')}
            >
              ← Change problem
            </button>
            <button
              type="button"
              className="hiring-btn hiring-btn-primary hiring-btn-sm"
              onClick={() => goToStage('invite')}
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
          {!issuedResult ? (
            <>
              <header className="hiring-preview-header">
                <div className="hiring-stack-xs">
                  <h2>Issue the invitation</h2>
                  <strong>
                    {activeDraft.title} · {activeDraft.durationMinutes} min
                  </strong>
                  <p className="hiring-muted-copy">
                    Candidate AI assistant:{' '}
                    {activeDraft.integratedAi ? 'Enabled' : 'Off'} ·{' '}
                    {activeDraft.starterFiles.length} starter files. The
                    invitation appears in the candidate’s account and via direct
                    link.
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
                <div className="hiring-invitation-fields">
                  <div className="hiring-field">
                    <label htmlFor="issue-candidate-email">
                      Candidate email
                    </label>
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
                        <option
                          key={member.principalId}
                          value={member.principalId}
                        >
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
                    type="button"
                    className="hiring-btn"
                    onClick={() => goToStage('preview')}
                  >
                    ← Back to preview
                  </button>
                  <button
                    type="submit"
                    className="hiring-btn hiring-btn-primary"
                    disabled={issuing || creditsBlocked}
                  >
                    <IconSend size={16} />{' '}
                    {issuing
                      ? 'Issuing assessment...'
                      : 'Save & Issue Assessment'}
                  </button>
                </div>
              </form>
            </>
          ) : null}

          {issuedResult ? (
            <div className="hiring-issued-box">
              <div className="hiring-candidate-name">
                <h2 ref={issuedHeading} tabIndex={-1}>
                  Assessment issued
                </h2>
              </div>
              <p className="hiring-muted-copy">
                <strong>{activeDraft.title}</strong> is ready in the candidate
                portal for <strong>{issuedResult.recipient}</strong>.
              </p>
              {issuedResult.expiresAt ? (
                <p className="hiring-muted-copy">
                  Expires{' '}
                  <LocalTime timestamp={issuedResult.expiresAt} absolute />
                </p>
              ) : null}
              <p className="hiring-muted-copy">
                Share the link directly with the candidate.
              </p>
              <div className="hiring-issued-link-row">
                <input
                  type="text"
                  readOnly
                  ref={issuedLinkInput}
                  value={invitationUrl}
                  aria-label="Issued candidate link"
                  className="hiring-issued-link-input"
                />
                <CopyActionButton
                  value={invitationUrl}
                  label="Copy invite link"
                  copiedLabel="Copied"
                  toastMessage="Candidate invite link copied."
                  size="md"
                  variant="secondary"
                  className="hiring-btn hiring-btn-primary"
                  onCopied={() => setCopyFallback(null)}
                  onCopyError={() => {
                    setCopyFallback('link');
                    issuedLinkInput.current?.focus();
                    issuedLinkInput.current?.select();
                  }}
                />
              </div>
              {copyFallback === 'link' ? (
                <p className="hiring-muted-copy" role="alert">
                  Clipboard unavailable. Select and copy the link above.
                </p>
              ) : null}
              <div className="hiring-header-actions hiring-mt-sm">
                <CopyActionButton
                  value={invitationEmail}
                  label="Copy email message"
                  copiedLabel="Message copied"
                  toastMessage="Ready-to-send email message copied."
                  size="sm"
                  variant="secondary"
                  onCopied={() => setCopyFallback(null)}
                  onCopyError={() => setCopyFallback('email')}
                />
                <button
                  type="button"
                  className="hiring-btn hiring-btn-sm"
                  onClick={resetForAnotherCandidate}
                >
                  Invite another candidate
                </button>
                <Link
                  className="hiring-btn hiring-btn-sm"
                  href={`${orgBase}/candidates`}
                >
                  View in Candidates →
                </Link>
              </div>
              {copyFallback === 'email' ? (
                <div className="hiring-field">
                  <p className="hiring-muted-copy" role="alert">
                    Clipboard unavailable. Select and copy the message below.
                  </p>
                  <label htmlFor="issued-email-message">Invitation email</label>
                  <textarea
                    id="issued-email-message"
                    rows={8}
                    readOnly
                    value={invitationEmail}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
