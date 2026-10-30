'use client';

import Link from 'next/link';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import {
  assessmentDepths,
  assessmentDomains,
  assessmentDurations,
  assessmentFields,
  assessmentStacks,
  assessmentWorkKinds,
  isSupportedAssessmentSelection,
  type AssessmentSelection,
} from '../../../../src/assessments/assessment-options';
import type { TaskRubricSnapshot } from '../../../../src/assessments/task-rubric';
import { SoftwareProductHeader } from '../../software-product-header';
import { AssessmentChoice } from './assessment-choice';
import {
  parseAssessmentDraft,
  parseAssessmentSelection,
} from '../../../../src/assessments/assessment-selection';
import './assessment-builder.css';

type Draft = {
  field: string;
  workKind: string;
  domain: string;
  stack: string;
  depth: string;
  durationMinutes: string;
  integratedAi: boolean;
  terminalEnabled: boolean;
  rubricWeights: Record<string, number | ''>;
};

type CreatedLink = {
  sessionId: string;
  candidatePath: string;
  recovered?: boolean;
  scenario: { title: string; version: string; durationSeconds: number };
  taskRubric: TaskRubric;
  terminalEnabled: boolean;
};

type PendingIssuance = Readonly<{
  key: string;
  payload: Readonly<Record<string, unknown>>;
}>;

const pendingIssuanceStorageKey = 'hirearchy-assessment-issuance-v1';

type PendingIssuanceStorageSnapshot = Readonly<{
  pending: PendingIssuance | null;
  unavailable: boolean;
}>;

const emptyPendingIssuanceStorageSnapshot: PendingIssuanceStorageSnapshot = {
  pending: null,
  unavailable: false,
};
let cachedPendingIssuanceStorageValue: string | null | undefined;
let cachedPendingIssuanceStorageSnapshot = emptyPendingIssuanceStorageSnapshot;

const subscribeToPendingIssuanceStorage = () => () => {};

const getPendingIssuanceStorageSnapshot =
  (): PendingIssuanceStorageSnapshot => {
    if (typeof window === 'undefined')
      return emptyPendingIssuanceStorageSnapshot;
    try {
      const raw = window.sessionStorage.getItem(pendingIssuanceStorageKey);
      if (raw === cachedPendingIssuanceStorageValue)
        return cachedPendingIssuanceStorageSnapshot;
      cachedPendingIssuanceStorageValue = raw;
      if (raw === null) {
        cachedPendingIssuanceStorageSnapshot =
          emptyPendingIssuanceStorageSnapshot;
        return cachedPendingIssuanceStorageSnapshot;
      }
      const pending = parsePendingIssuance(JSON.parse(raw) as unknown);
      cachedPendingIssuanceStorageSnapshot = pending
        ? { pending, unavailable: false }
        : { pending: null, unavailable: true };
      return cachedPendingIssuanceStorageSnapshot;
    } catch {
      cachedPendingIssuanceStorageValue = undefined;
      if (!cachedPendingIssuanceStorageSnapshot.unavailable) {
        cachedPendingIssuanceStorageSnapshot = {
          pending: null,
          unavailable: true,
        };
      }
      return cachedPendingIssuanceStorageSnapshot;
    }
  };

const parsePendingIssuance = (value: unknown): PendingIssuance | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.key !== 'string' ||
    !/^[\x21-\x7e]{1,200}$/.test(candidate.key) ||
    !candidate.payload ||
    typeof candidate.payload !== 'object' ||
    Array.isArray(candidate.payload)
  ) {
    return null;
  }
  return {
    key: candidate.key,
    payload: candidate.payload as Record<string, unknown>,
  };
};

type TaskRubric = TaskRubricSnapshot;

type AssessmentPreview = Readonly<{
  generatedAssessmentId?: string;
  isCurated?: boolean;
  scenario: Readonly<{
    id: string;
    version: string;
    title: string;
    brief: string;
    acceptanceCriteria: readonly string[];
    durationSeconds: number;
  }>;
  taskRubric: TaskRubric;
  aiCapability: Readonly<{ enabled: boolean }>;
  terminalEnabled: boolean;
  recommendations?: Readonly<{
    durationMinutes: 30 | 45 | 60 | 90;
    integratedAi: boolean;
    terminalEnabled: boolean;
  }>;
}>;

type PreviewState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'loading' }>
  | Readonly<{
      kind: 'error';
      message: string;
      retryable: boolean;
      requiresEvaluatorAccess?: boolean;
      category: PreviewFailureCategory;
    }>
  | Readonly<{ kind: 'ready'; value: AssessmentPreview }>;

type BuilderStage = 'define' | 'validate' | 'issue';
type PreparationMode = 'curated' | 'generated';
type PreviewFailureCategory =
  'access' | 'configuration' | 'provider' | 'validation' | 'unavailable';
const builderStages: readonly Readonly<{
  stage: BuilderStage;
  label: string;
}>[] = [
  { stage: 'define', label: 'Define' },
  { stage: 'validate', label: 'Validate' },
  { stage: 'issue', label: 'Issue' },
];

type PreviewRequest = Readonly<{
  id: number;
  workKey: string;
  selection: AssessmentSelection;
}>;

type AssessmentRubricProps = Readonly<{
  currentPreview: AssessmentPreview;
  previewState: PreviewState;
  rubricWeightTotal: number;
  rubricWeightsValid: boolean;
  busy: boolean;
  created: boolean;
  draft: Draft;
  onUpdate: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
}>;

const isTaskRubric = (value: unknown): value is TaskRubric =>
  Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as TaskRubric).version === 'string' &&
    Array.isArray((value as TaskRubric).criteria) &&
    (value as TaskRubric).criteria.every(
      (criterion) =>
        typeof criterion.id === 'string' &&
        typeof criterion.label === 'string' &&
        typeof criterion.description === 'string' &&
        Number.isFinite(criterion.weight) &&
        typeof criterion.applicability?.rule === 'string' &&
        (criterion.applicability.kind === 'always' ||
          criterion.applicability.kind ===
            'recorded_integrated_ai_interaction'),
    ),
  );

const isAssessmentPreview = (value: unknown): value is AssessmentPreview =>
  Boolean(
    value &&
    typeof value === 'object' &&
    ((value as AssessmentPreview).generatedAssessmentId === undefined ||
      typeof (value as AssessmentPreview).generatedAssessmentId === 'string') &&
    typeof (value as AssessmentPreview).scenario?.id === 'string' &&
    typeof (value as AssessmentPreview).scenario?.version === 'string' &&
    typeof (value as AssessmentPreview).scenario?.title === 'string' &&
    Number.isInteger((value as AssessmentPreview).scenario?.durationSeconds) &&
    typeof (value as AssessmentPreview).scenario?.brief === 'string' &&
    Array.isArray((value as AssessmentPreview).scenario?.acceptanceCriteria) &&
    (value as AssessmentPreview).scenario.acceptanceCriteria.every(
      (criterion) => typeof criterion === 'string',
    ) &&
    isTaskRubric((value as AssessmentPreview).taskRubric) &&
    typeof (value as AssessmentPreview).aiCapability?.enabled === 'boolean' &&
    typeof (value as AssessmentPreview).terminalEnabled === 'boolean' &&
    (!(value as AssessmentPreview).recommendations ||
      (assessmentDurations.includes(
        (value as AssessmentPreview).recommendations
          ?.durationMinutes as (typeof assessmentDurations)[number],
      ) &&
        typeof (value as AssessmentPreview).recommendations?.integratedAi ===
          'boolean' &&
        typeof (value as AssessmentPreview).recommendations?.terminalEnabled ===
          'boolean')),
  );

const isCreatedLink = (value: unknown): value is CreatedLink =>
  Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as CreatedLink).sessionId === 'string' &&
    typeof (value as CreatedLink).candidatePath === 'string' &&
    typeof (value as CreatedLink).scenario?.title === 'string' &&
    typeof (value as CreatedLink).scenario?.version === 'string' &&
    Number.isInteger((value as CreatedLink).scenario?.durationSeconds) &&
    typeof (value as CreatedLink).terminalEnabled === 'boolean' &&
    isTaskRubric((value as CreatedLink).taskRubric),
  );

const getAssessmentError = (value: unknown, status: number) => {
  if (!value || typeof value !== 'object') {
    return 'The selected assessment could not be completed. Review the selections and try again.';
  }
  const responseValue = value as {
    error?: { code?: unknown };
    status?: unknown;
    message?: unknown;
  };
  if (status === 422 && responseValue.status === 'UNAVAILABLE_DRAFT') {
    return typeof responseValue.message === 'string'
      ? responseValue.message
      : 'The generated task did not pass validation. Try generating another task.';
  }
  const code =
    responseValue.error?.code ??
    (typeof value === 'object' && value !== null && 'code' in value
      ? (value as { code?: unknown }).code
      : undefined);
  if (code === 'EVALUATOR_ACCESS_REQUIRED') {
    return 'Evaluator access is required. Go to evaluator access and sign in again.';
  }
  if (code === 'ASSESSMENT_CAPABILITY_UNSUPPORTED') {
    return 'This authored task requires Terminal. Turn Terminal back on before issuing it.';
  }
  if (code === 'IDEMPOTENCY_KEY_CONFLICT') {
    return 'This request key is bound to a different assessment. Start a new assessment intent to issue a separate session.';
  }
  if (code === 'CANDIDATE_TOKEN_STORAGE_UNAVAILABLE') {
    return 'Secure candidate-link recovery is temporarily unavailable. Retry this saved request after evaluator access is restored.';
  }
  if (code === 'ASSESSMENT_NOT_READY') {
    return 'This work setup is still being prepared. Choose an available work option.';
  }
  if (code === 'ASSESSMENT_NOT_PREPARED') {
    return 'Generate and validate a task before creating a candidate link.';
  }
  if (code === 'GENERATED_ASSESSMENT_UNAVAILABLE') {
    return 'The validated task is unavailable. Generate it again before creating a candidate link.';
  }
  if (
    (typeof code === 'string' && code.startsWith('PROVIDER_')) ||
    (status === 503 && responseValue.status === 'UNAVAILABLE_DRAFT')
  ) {
    return 'The task provider is unavailable or did not return a usable task. Try again later.';
  }
  if (status === 503) {
    return 'This task is temporarily unavailable. Try again later.';
  }
  if (status >= 500) {
    return 'The request could not be completed. Please try again.';
  }
  return 'The selected assessment could not be completed. Review the selections and try again.';
};

const isEvaluatorAuthorizationError = (value: unknown) =>
  Boolean(
    value &&
    typeof value === 'object' &&
    (value as { error?: { code?: unknown } }).error?.code ===
      'EVALUATOR_ACCESS_REQUIRED',
  );

const getAssessmentFailureCategory = (
  value: unknown,
  status: number,
): PreviewFailureCategory => {
  if (isEvaluatorAuthorizationError(value)) return 'access';
  const code =
    value && typeof value === 'object' && 'code' in value
      ? (value as { code?: unknown }).code
      : value && typeof value === 'object' && 'error' in value
        ? (value as { error?: { code?: unknown } }).error?.code
        : undefined;
  if (
    code === 'ASSESSMENT_NOT_READY' ||
    code === 'ASSESSMENT_CAPABILITY_UNSUPPORTED'
  )
    return 'configuration';
  if (code === 'SCENARIO_UNAVAILABLE') return 'unavailable';
  if (typeof code === 'string' && code.startsWith('PROVIDER_'))
    return 'provider';
  if (status === 422) return 'validation';
  if (status === 503) return 'provider';
  return 'unavailable';
};

const storageKey = 'hirearchy-assessment-draft-v1';
const emptyDraft: Draft = {
  field: '',
  workKind: '',
  domain: '',
  stack: '',
  depth: '',
  durationMinutes: '',
  integratedAi: false,
  terminalEnabled: true,
  rubricWeights: {},
};
const getWorkKey = (draft: Draft) =>
  JSON.stringify([
    draft.field,
    draft.workKind,
    draft.domain,
    draft.stack,
    draft.depth,
  ]);
const formatElapsedSeconds = (totalSeconds: number) =>
  `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
const getCriterionWeight = (
  criterion: TaskRubric['criteria'][number],
  overrides: Draft['rubricWeights'],
) => {
  const override = overrides[criterion.id];
  return override === '' ? 0 : (override ?? criterion.weight);
};
type AssessmentDraftSnapshot = Readonly<{
  draft: Draft;
  error: string | null;
}>;
const emptyAssessmentDraftSnapshot: AssessmentDraftSnapshot = {
  draft: emptyDraft,
  error: null,
};
const assessmentDraftChangedEvent = 'hirearchy:assessment-draft-changed';
let cachedAssessmentDraftRaw: string | null | undefined;
let cachedAssessmentDraftSnapshot = emptyAssessmentDraftSnapshot;

const getAssessmentDraftSnapshot = (): AssessmentDraftSnapshot => {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(storageKey);
  } catch {
    cachedAssessmentDraftRaw = undefined;
    if (
      cachedAssessmentDraftSnapshot.error !==
      'Saved drafts are unavailable in this browser.'
    ) {
      cachedAssessmentDraftSnapshot = {
        draft: cachedAssessmentDraftSnapshot.draft,
        error: 'Saved drafts are unavailable in this browser.',
      };
    }
    return cachedAssessmentDraftSnapshot;
  }
  if (raw === cachedAssessmentDraftRaw) return cachedAssessmentDraftSnapshot;
  cachedAssessmentDraftRaw = raw;
  if (!raw) {
    cachedAssessmentDraftSnapshot = emptyAssessmentDraftSnapshot;
    return cachedAssessmentDraftSnapshot;
  }

  try {
    const saved = JSON.parse(raw) as Record<string, unknown>;
    const { rubricWeights, ...selectionValues } = saved;
    const parsed = parseAssessmentDraft(selectionValues);
    if (!parsed) throw new Error('Invalid saved draft');
    cachedAssessmentDraftSnapshot = {
      draft: {
        ...emptyDraft,
        ...parsed,
        durationMinutes: parsed.durationMinutes?.toString() ?? '',
        terminalEnabled: parsed.terminalEnabled ?? true,
        rubricWeights:
          rubricWeights &&
          typeof rubricWeights === 'object' &&
          !Array.isArray(rubricWeights)
            ? Object.fromEntries(
                Object.entries(rubricWeights).filter(
                  ([, weight]) =>
                    typeof weight === 'number' &&
                    Number.isInteger(weight) &&
                    weight >= 1 &&
                    weight <= 100,
                ),
              )
            : {},
      },
      error: null,
    };
    return cachedAssessmentDraftSnapshot;
  } catch {
    const message = 'The saved draft could not be read. Start a new draft.';
    if (cachedAssessmentDraftSnapshot.error !== message) {
      cachedAssessmentDraftSnapshot = {
        draft: emptyDraft,
        error: message,
      };
    }
    return cachedAssessmentDraftSnapshot;
  }
};

const subscribeToAssessmentDraft = (callback: () => void) => {
  window.addEventListener('storage', callback);
  window.addEventListener(assessmentDraftChangedEvent, callback);
  return () => {
    window.removeEventListener('storage', callback);
    window.removeEventListener(assessmentDraftChangedEvent, callback);
  };
};

const AssessmentRubric = ({
  currentPreview,
  previewState,
  rubricWeightTotal,
  rubricWeightsValid,
  busy,
  created,
  draft,
  onUpdate,
}: AssessmentRubricProps) => (
  <section
    className="assessment-rubric"
    aria-labelledby="assessment-rubric-title"
  >
    <div className="assessment-rubric-heading">
      <div>
        <h3 id="assessment-rubric-title">Rubric weight allocation</h3>
        <p>Set the human-authored rubric weights for this task.</p>
      </div>
      <span>Selected weights {rubricWeightTotal}%</span>
    </div>
    <p className="assessment-weight-guidance" id="assessment-rubric-help">
      Each weight must be a whole number from 1 to 100, and the total must equal
      100%.
    </p>
    <ol className="assessment-rubric-list">
      {currentPreview.taskRubric.criteria.map((criterion) => {
        const recommendedWeight =
          previewState.kind === 'ready'
            ? (previewState.value.taskRubric.criteria.find(
                (item) => item.id === criterion.id,
              )?.weight ?? criterion.weight)
            : criterion.weight;
        return (
          <li key={criterion.id}>
            <div>
              <strong>{criterion.label}</strong>
              <small>Recommended {recommendedWeight}%</small>
              {criterion.applicability.kind !== 'always' ? (
                <small>
                  {currentPreview.aiCapability.enabled
                    ? 'Applies when an integrated AI interaction is recorded.'
                    : 'Not applicable: integrated AI is disabled for this assessment.'}
                </small>
              ) : null}
            </div>
            <label className="assessment-weight-input">
              <span className="assessment-visually-hidden">
                Weight for {criterion.label}
              </span>
              <input
                aria-describedby="assessment-rubric-help"
                aria-label={`Weight for ${criterion.label}`}
                aria-invalid={!rubricWeightsValid}
                disabled={busy || created}
                max={100}
                min={1}
                onChange={(event) =>
                  onUpdate('rubricWeights', {
                    ...draft.rubricWeights,
                    [criterion.id]:
                      event.target.value === ''
                        ? ''
                        : Number(event.target.value),
                  })
                }
                type="number"
                value={draft.rubricWeights[criterion.id] ?? criterion.weight}
              />
              <span aria-hidden="true">%</span>
            </label>
          </li>
        );
      })}
    </ol>
    <div className="assessment-rubric-footer">
      <details className="assessment-disclosure">
        <summary>Rubric guidance</summary>
        <dl>
          {currentPreview.taskRubric.criteria.map((criterion) => (
            <div key={criterion.id}>
              <dt>{criterion.label}</dt>
              <dd>{criterion.description}</dd>
            </div>
          ))}
        </dl>
      </details>
      <button
        className="assessment-secondary-button"
        disabled={
          busy || created || Object.keys(draft.rubricWeights).length === 0
        }
        onClick={() => onUpdate('rubricWeights', {})}
        type="button"
      >
        Reset weights
      </button>
    </div>
    {!rubricWeightsValid ? (
      <p className="assessment-inline-warning" role="status">
        Selected weights must be positive whole numbers totaling 100% before a
        candidate session can be created.
      </p>
    ) : null}
    {currentPreview.recommendations ? (
      <section
        className="assessment-recommendations"
        aria-labelledby="assessment-recommendations-title"
      >
        <div>
          <h4 id="assessment-recommendations-title">Task recommendations</h4>
          <p>
            Optional settings from the generated task. Applying one does not
            regenerate it.
          </p>
        </div>
        {[
          {
            label: `Time · ${currentPreview.recommendations.durationMinutes} minutes`,
            accessibleLabel: `Use recommended duration ${currentPreview.recommendations.durationMinutes} minutes`,
            disabled:
              draft.durationMinutes ===
              String(currentPreview.recommendations.durationMinutes),
            apply: () =>
              onUpdate(
                'durationMinutes',
                String(currentPreview.recommendations!.durationMinutes),
              ),
          },
          {
            label: `Terminal · ${currentPreview.recommendations.terminalEnabled ? 'enabled' : 'disabled'}`,
            accessibleLabel: `Use recommended Terminal ${currentPreview.recommendations.terminalEnabled ? 'enabled' : 'disabled'}`,
            disabled:
              draft.terminalEnabled ===
              currentPreview.recommendations.terminalEnabled,
            apply: () =>
              onUpdate(
                'terminalEnabled',
                currentPreview.recommendations!.terminalEnabled,
              ),
          },
          {
            label: `AI assistant · ${currentPreview.recommendations.integratedAi ? 'enabled' : 'disabled'}`,
            accessibleLabel: `Use recommended AI assistant ${currentPreview.recommendations.integratedAi ? 'enabled' : 'disabled'}`,
            disabled:
              draft.integratedAi ===
              currentPreview.recommendations.integratedAi,
            apply: () =>
              onUpdate(
                'integratedAi',
                currentPreview.recommendations!.integratedAi,
              ),
          },
        ].map((recommendation) => (
          <div className="assessment-recommendation" key={recommendation.label}>
            <span>{recommendation.label}</span>
            <button
              aria-label={recommendation.accessibleLabel}
              className="assessment-text-button"
              disabled={busy || created || recommendation.disabled}
              onClick={recommendation.apply}
              type="button"
            >
              Use recommendation
            </button>
          </div>
        ))}
      </section>
    ) : null}
  </section>
);

export const AssessmentBuilder = () => {
  const persistedDraft = useSyncExternalStore(
    subscribeToAssessmentDraft,
    getAssessmentDraftSnapshot,
    () => emptyAssessmentDraftSnapshot,
  );
  const [draftOverride, setDraftOverride] = useState<Draft | null>(null);
  const draft = draftOverride ?? persistedDraft.draft;
  const [selectedStage, setStage] = useState<BuilderStage>('define');
  const pendingStorageSnapshot = useSyncExternalStore(
    subscribeToPendingIssuanceStorage,
    getPendingIssuanceStorageSnapshot,
    () => emptyPendingIssuanceStorageSnapshot,
  );
  const [pendingIssuanceOverride, setPendingIssuanceOverride] = useState<
    PendingIssuance | null | undefined
  >(undefined);
  const [
    pendingStorageUnavailableOverride,
    setPendingStorageUnavailableOverride,
  ] = useState<boolean | null>(null);
  const pendingIssuance =
    pendingIssuanceOverride === undefined
      ? pendingStorageSnapshot.pending
      : pendingIssuanceOverride;
  const pendingStorageUnavailable =
    pendingStorageUnavailableOverride ?? pendingStorageSnapshot.unavailable;
  const stage =
    pendingIssuance || pendingStorageUnavailable ? 'issue' : selectedStage;
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requiresEvaluatorAccess, setRequiresEvaluatorAccess] = useState(false);
  const [issuanceUncertain, setIssuanceUncertain] = useState(false);
  const [issuanceConflict, setIssuanceConflict] = useState(false);
  const [issuanceRejected, setIssuanceRejected] = useState(false);
  const [created, setCreated] = useState<CreatedLink | null>(null);
  const hasUnresolvedIssuance = Boolean(
    issuanceUncertain || pendingIssuance || pendingStorageUnavailable,
  );
  const [copied, setCopied] = useState(false);
  const [preparationMode, setPreparationMode] =
    useState<PreparationMode | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState>({
    kind: 'idle',
  });
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [previewRequest, setPreviewRequest] = useState<PreviewRequest | null>(
    null,
  );
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [expandedBriefId, setExpandedBriefId] = useState<string | null>(null);
  const stageHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousStage = useRef<BuilderStage>('define');
  const previousPreviewKind = useRef<PreviewState['kind']>('idle');
  const createdStatusRef = useRef<HTMLDivElement>(null);
  const candidateLinkRef = useRef<HTMLInputElement>(null);
  const preparedTaskHeadingRef = useRef<HTMLHeadingElement>(null);
  const preparationFeedbackRef = useRef<HTMLDivElement>(null);
  const nextPreviewRequestId = useRef(0);
  const workKey = getWorkKey(draft);
  const currentWorkKey = useRef(workKey);

  const selection = useMemo(
    () =>
      parseAssessmentSelection({
        field: draft.field,
        workKind: draft.workKind,
        domain: draft.domain,
        stack: draft.stack,
        depth: draft.depth,
        durationMinutes: Number(draft.durationMinutes),
        integratedAi: draft.integratedAi,
        terminalEnabled: draft.terminalEnabled,
      }),
    [draft],
  );
  const hasCompleteSelection = Boolean(selection);
  const isReady = Boolean(
    selection && isSupportedAssessmentSelection(selection),
  );
  const generationBlocker =
    draft.stack && draft.stack !== 'python-flask'
      ? 'This stack is not yet available. Choose Python · Flask to generate and validate a task.'
      : !hasCompleteSelection
        ? `Choose ${[
            !draft.field && 'a technical field',
            !draft.stack && 'a stack',
            !draft.domain && 'a domain',
            !draft.depth && 'a scope',
            !draft.workKind && 'a challenge',
            !draft.durationMinutes && 'a working time budget',
          ]
            .filter(Boolean)
            .join(', ')} to enable task generation.`
        : null;
  const previewStateForSelection =
    previewKey === workKey ? previewState : { kind: 'idle' as const };
  const generationKey =
    previewStateForSelection.kind === 'loading' ? workKey : null;

  useEffect(() => {
    currentWorkKey.current = workKey;
  }, [workKey]);

  useEffect(() => {
    if (previousStage.current === stage) return;
    previousStage.current = stage;
    stageHeadingRef.current?.focus();
  }, [stage]);

  useEffect(() => {
    const previousKind = previousPreviewKind.current;
    const currentKind = previewStateForSelection.kind;
    previousPreviewKind.current = currentKind;
    if (
      stage === 'validate' &&
      previousKind === 'loading' &&
      currentKind !== 'loading' &&
      currentKind !== 'idle'
    ) {
      if (currentKind === 'ready') preparedTaskHeadingRef.current?.focus();
      if (currentKind === 'error') preparationFeedbackRef.current?.focus();
    }
  }, [previewStateForSelection.kind, stage]);

  useEffect(() => {
    if (created) createdStatusRef.current?.focus();
  }, [created]);

  useEffect(() => {
    if (!previewRequest || previewRequest.workKey !== workKey) return;

    const controller = new AbortController();
    const requestKey = previewRequest.workKey;
    const isCurrentRequest = () =>
      !controller.signal.aborted && currentWorkKey.current === requestKey;
    void fetch('/api/evaluator/assessments/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(previewRequest.selection),
      signal: controller.signal,
    })
      .then(async (response) => {
        const value: unknown = await response.json();
        if (!response.ok) {
          const category = getAssessmentFailureCategory(value, response.status);
          throw Object.assign(
            new Error(getAssessmentError(value, response.status)),
            {
              publicMessage: getAssessmentError(value, response.status),
              category,
              retryable:
                response.status >= 500 ||
                (response.status === 422 &&
                  typeof value === 'object' &&
                  value !== null &&
                  'status' in value &&
                  value.status === 'UNAVAILABLE_DRAFT'),
              requiresEvaluatorAccess: isEvaluatorAuthorizationError(value),
            },
          );
        }
        if (!isAssessmentPreview(value)) {
          throw Object.assign(
            new Error('The task preview could not be read. Please try again.'),
            {
              publicMessage:
                'The task preview could not be read. Please try again.',
              retryable: true,
              category: 'unavailable' as const,
            },
          );
        }
        if (isCurrentRequest()) {
          setPreviewKey(requestKey);
          setPreviewState({ kind: 'ready', value });
        }
      })
      .catch((requestError: unknown) => {
        if (isCurrentRequest()) {
          setPreviewKey(requestKey);
          setPreviewState({
            kind: 'error',
            message:
              typeof requestError === 'object' &&
              requestError !== null &&
              'publicMessage' in requestError &&
              typeof requestError.publicMessage === 'string'
                ? requestError.publicMessage
                : 'The task could not be reached. Check your connection and try again.',
            category:
              typeof requestError === 'object' &&
              requestError !== null &&
              'category' in requestError &&
              typeof requestError.category === 'string' &&
              [
                'access',
                'configuration',
                'provider',
                'validation',
                'unavailable',
              ].includes(requestError.category)
                ? (requestError.category as PreviewFailureCategory)
                : 'unavailable',
            retryable:
              typeof requestError === 'object' &&
              requestError !== null &&
              'retryable' in requestError
                ? Boolean(requestError.retryable)
                : true,
            requiresEvaluatorAccess:
              typeof requestError === 'object' &&
              requestError !== null &&
              'requiresEvaluatorAccess' in requestError &&
              Boolean(requestError.requiresEvaluatorAccess),
          });
        }
      })
      .finally(() => {
        if (isCurrentRequest()) {
          setPreviewRequest((current) =>
            current?.id === previewRequest.id ? null : current,
          );
        }
      });

    return () => controller.abort();
  }, [previewRequest, workKey]);

  useEffect(() => {
    if (generationKey === null) return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [generationKey]);

  const prepareTask = () => {
    if (!selection || !isSupportedAssessmentSelection(selection)) return;
    setError(null);
    setRequiresEvaluatorAccess(false);
    setPreparationMode('generated');
    const request: PreviewRequest = {
      id: ++nextPreviewRequestId.current,
      workKey,
      selection,
    };
    setPreviewKey(workKey);
    setElapsedSeconds(0);
    setPreviewState({ kind: 'loading' });
    setPreviewRequest(request);
  };

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    const nextDraft = {
      ...draft,
      [key]: value,
    };
    const workChanged = getWorkKey(nextDraft) !== workKey;
    setDraftOverride(
      workChanged ? { ...nextDraft, rubricWeights: {} } : nextDraft,
    );
    setSaved(false);
    setCreated(null);
    setCopied(false);
    setError(null);
    setRequiresEvaluatorAccess(false);
    if (workChanged) {
      currentWorkKey.current = getWorkKey(nextDraft);
      setPreviewKey(null);
      setPreviewState({ kind: 'idle' });
      setPreviewRequest(null);
      setPreparationMode(null);
    }
  };

  const saveDraft = () => {
    const savedDraft = {
      ...(draft.field ? { field: draft.field } : {}),
      ...(draft.workKind ? { workKind: draft.workKind } : {}),
      ...(draft.domain ? { domain: draft.domain } : {}),
      ...(draft.stack ? { stack: draft.stack } : {}),
      ...(draft.depth ? { depth: draft.depth } : {}),
      ...(draft.durationMinutes
        ? { durationMinutes: Number(draft.durationMinutes) }
        : {}),
      integratedAi: draft.integratedAi,
      terminalEnabled: draft.terminalEnabled,
      rubricWeights: draft.rubricWeights,
    };
    try {
      const serialized = JSON.stringify(savedDraft);
      window.localStorage.setItem(storageKey, serialized);
      cachedAssessmentDraftRaw = serialized;
      cachedAssessmentDraftSnapshot = { draft, error: null };
      setDraftOverride(null);
      window.dispatchEvent(new Event(assessmentDraftChangedEvent));
      setSaved(true);
      setError(null);
      setRequiresEvaluatorAccess(false);
    } catch {
      setSaved(false);
      setError(
        'Draft could not be saved on this device. Your current selections are still on this page.',
      );
    }
  };

  const loadCuratedTask = async () => {
    if (!selection || !isSupportedAssessmentSelection(selection)) return;
    setError(null);
    setRequiresEvaluatorAccess(false);
    setPreparationMode('curated');
    const requestKey = workKey;
    setPreviewKey(requestKey);
    setElapsedSeconds(0);
    if (!draft.terminalEnabled) {
      setPreviewState({
        kind: 'error',
        category: 'configuration',
        message:
          'The fixed authored blueprint requires Terminal so candidates can run pytest and record verification.',
        retryable: false,
      });
      return;
    }
    setPreviewState({ kind: 'loading' });
    try {
      const response = await fetch('/api/evaluator/assessments/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selection),
      });
      const value: unknown = await response.json();
      if (!response.ok) {
        const category = getAssessmentFailureCategory(value, response.status);
        throw Object.assign(
          new Error(getAssessmentError(value, response.status)),
          {
            publicMessage: getAssessmentError(value, response.status),
            category,
            retryable: response.status >= 500,
            requiresEvaluatorAccess: isEvaluatorAuthorizationError(value),
          },
        );
      }
      if (!isAssessmentPreview(value)) {
        throw Object.assign(
          new Error('The task preview could not be read. Please try again.'),
          {
            publicMessage:
              'The task preview could not be read. Please try again.',
            retryable: true,
            category: 'unavailable' as const,
          },
        );
      }
      if (currentWorkKey.current === requestKey) {
        setPreviewKey(requestKey);
        setPreviewState({
          kind: 'ready',
          value: { ...value, isCurated: true },
        });
      }
    } catch (requestError: unknown) {
      if (currentWorkKey.current === requestKey) {
        setPreviewState({
          kind: 'error',
          message:
            typeof requestError === 'object' &&
            requestError !== null &&
            'publicMessage' in requestError &&
            typeof requestError.publicMessage === 'string'
              ? requestError.publicMessage
              : 'The task could not be reached. Check your connection and try again.',
          category:
            typeof requestError === 'object' &&
            requestError !== null &&
            'category' in requestError &&
            typeof requestError.category === 'string' &&
            [
              'access',
              'configuration',
              'provider',
              'validation',
              'unavailable',
            ].includes(requestError.category)
              ? (requestError.category as PreviewFailureCategory)
              : 'unavailable',
          retryable:
            typeof requestError === 'object' &&
            requestError !== null &&
            'retryable' in requestError
              ? Boolean(requestError.retryable)
              : true,
          requiresEvaluatorAccess:
            typeof requestError === 'object' &&
            requestError !== null &&
            'requiresEvaluatorAccess' in requestError &&
            Boolean(requestError.requiresEvaluatorAccess),
        });
      }
    }
  };

  const createAssessment = async () => {
    if (busy || created || issuanceConflict) return;
    let pending = pendingIssuance;
    if (!pending) {
      if (
        !selection ||
        !isSupportedAssessmentSelection(selection) ||
        previewStateForSelection.kind !== 'ready' ||
        !rubricWeightsValid ||
        hasUnresolvedIssuance ||
        pendingStorageUnavailable ||
        ((previewStateForSelection.value.isCurated ||
          !previewStateForSelection.value.generatedAssessmentId) &&
          !draft.terminalEnabled)
      ) {
        return;
      }
      const taskRubric = previewStateForSelection.value.taskRubric;
      const rubricWeights = Object.fromEntries(
        taskRubric.criteria.map((criterion) => [
          criterion.id,
          getCriterionWeight(criterion, draft.rubricWeights),
        ]),
      );
      const hasCustomRubricWeights = taskRubric.criteria.some(
        (criterion) => rubricWeights[criterion.id] !== criterion.weight,
      );
      const isCurated =
        !previewStateForSelection.value.generatedAssessmentId ||
        previewStateForSelection.value.isCurated;
      try {
        pending = {
          key: window.crypto.randomUUID(),
          payload: {
            ...selection,
            ...(isCurated
              ? { useCuratedBlueprint: true }
              : {
                  generatedAssessmentId:
                    previewStateForSelection.value.generatedAssessmentId,
                }),
            ...(hasCustomRubricWeights ? { rubricWeights } : {}),
          },
        };
        window.sessionStorage.setItem(
          pendingIssuanceStorageKey,
          JSON.stringify(pending),
        );
      } catch {
        setPendingStorageUnavailableOverride(true);
        setError(
          'This browser could not retain the request key for a safe retry. No assessment was sent.',
        );
        return;
      }
      setPendingIssuanceOverride(pending);
      setPendingStorageUnavailableOverride(false);
    }
    setBusy(true);
    setCopied(false);
    setError(null);
    setRequiresEvaluatorAccess(false);
    setIssuanceRejected(false);
    try {
      const response = await fetch('/api/evaluator/assessments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': pending.key,
        },
        body: JSON.stringify(pending.payload),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const code =
          result && typeof result === 'object' && 'error' in result
            ? (result as { error?: { code?: unknown } }).error?.code
            : undefined;
        if (code === 'IDEMPOTENCY_KEY_CONFLICT') {
          setIssuanceConflict(true);
          setIssuanceUncertain(false);
          setIssuanceRejected(false);
        } else {
          setIssuanceUncertain(true);
          setIssuanceRejected(true);
        }
        setError(getAssessmentError(result, response.status));
        setRequiresEvaluatorAccess(isEvaluatorAuthorizationError(result));
        return;
      }
      if (!isCreatedLink(result)) {
        setIssuanceUncertain(true);
        setError(
          'The response did not confirm whether the session was created. Retry the same saved request to recover it.',
        );
        return;
      }
      try {
        window.sessionStorage.removeItem(pendingIssuanceStorageKey);
      } catch {
        // A later reload can safely replay the same key and recover this link.
      }
      setStage('issue');
      setCreated({ ...result, recovered: response.status === 200 });
      setPendingIssuanceOverride(null);
      setIssuanceUncertain(false);
      setIssuanceConflict(false);
      setIssuanceRejected(false);
      setPendingStorageUnavailableOverride(false);
      setRequiresEvaluatorAccess(false);
    } catch {
      setIssuanceUncertain(true);
      setStage('issue');
      setError(
        'The response was lost. Retry to recover the session with the same request key.',
      );
      setRequiresEvaluatorAccess(false);
    } finally {
      setBusy(false);
    }
  };

  const startNewAssessmentIntent = () => {
    try {
      window.sessionStorage.removeItem(pendingIssuanceStorageKey);
    } catch {
      // The next attempt stores and sends a fresh key before contacting server.
    }
    setPendingIssuanceOverride(null);
    setPendingStorageUnavailableOverride(false);
    setIssuanceUncertain(false);
    setIssuanceConflict(false);
    setIssuanceRejected(false);
    setCreated(null);
    setCopied(false);
    setError(null);
    setRequiresEvaluatorAccess(false);
    setStage('issue');
  };

  const copyLink = async () => {
    if (!created) return;
    setCopied(false);
    setError(null);
    setRequiresEvaluatorAccess(false);
    try {
      await navigator.clipboard.writeText(
        new URL(created.candidatePath, window.location.origin).toString(),
      );
      setCopied(true);
    } catch {
      candidateLinkRef.current?.select();
      setError(
        'Clipboard access is unavailable. Select the link below to copy it.',
      );
    }
  };

  const currentPreview =
    previewStateForSelection.kind === 'ready'
      ? {
          ...previewStateForSelection.value,
          scenario: {
            ...previewStateForSelection.value.scenario,
            durationSeconds: Number(draft.durationMinutes || 0) * 60,
          },
          aiCapability: { enabled: draft.integratedAi },
          terminalEnabled: draft.terminalEnabled,
          taskRubric: created?.taskRubric ?? {
            ...previewStateForSelection.value.taskRubric,
            criteria: previewStateForSelection.value.taskRubric.criteria.map(
              (criterion) => ({
                ...criterion,
                weight: getCriterionWeight(criterion, draft.rubricWeights),
              }),
            ),
          },
        }
      : null;
  const briefExpanded =
    currentPreview !== null &&
    expandedBriefId ===
      (currentPreview.generatedAssessmentId ?? currentPreview.scenario.id);
  const rubricWeightsValid = Boolean(
    currentPreview &&
    currentPreview.taskRubric.criteria.every(
      (criterion) =>
        Number.isInteger(criterion.weight) &&
        criterion.weight >= 1 &&
        criterion.weight <= 100,
    ) &&
    currentPreview.taskRubric.criteria.reduce(
      (total, criterion) => total + criterion.weight,
      0,
    ) === 100,
  );
  const rubricWeightTotal =
    currentPreview?.taskRubric.criteria.reduce(
      (total, criterion) => total + criterion.weight,
      0,
    ) ?? 0;
  const isCuratedPreview = Boolean(
    currentPreview &&
    (currentPreview.isCurated || !currentPreview.generatedAssessmentId),
  );
  const curatedTerminalBlocker = Boolean(
    isCuratedPreview && !currentPreview?.terminalEnabled,
  );
  const canIssue = Boolean(
    currentPreview &&
    selection &&
    isReady &&
    rubricWeightsValid &&
    !busy &&
    !hasUnresolvedIssuance &&
    !issuanceConflict &&
    !pendingStorageUnavailable &&
    !curatedTerminalBlocker,
  );
  const selectedField =
    assessmentFields.find((option) => option.id === draft.field)?.label ??
    'Not selected';
  const selectedStack =
    assessmentStacks.find((option) => option.id === draft.stack)?.label ??
    'Not selected';
  const selectedDomain =
    assessmentDomains.find((option) => option.id === draft.domain)?.label ??
    'Not selected';
  const selectedWorkKind =
    assessmentWorkKinds.find((option) => option.id === draft.workKind)?.label ??
    'Not selected';
  const selectedDepth =
    assessmentDepths.find((option) => option.id === draft.depth)?.label ??
    'Not selected';
  const activeStageCopy = {
    define: {
      number: '01',
      title: 'Define the work sample',
      description: 'Choose the work context, time budget, and candidate tools.',
    },
    validate: {
      number: '02',
      title: 'Prepare and validate a task',
      description:
        'Use the published authored task or generate one for this work setup.',
    },
    issue: {
      number: '03',
      title: 'Review and issue',
      description:
        'Confirm what the candidate will receive before creating a session.',
    },
  }[stage];
  const previewErrorTitle =
    previewStateForSelection.kind === 'error'
      ? {
          access: 'Evaluator access required',
          configuration: 'This setup cannot be prepared',
          provider: 'Task provider unavailable',
          validation: 'Task validation did not pass',
          unavailable: 'Task preparation could not be completed',
        }[previewStateForSelection.category]
      : '';
  const taskOrigin = isCuratedPreview
    ? 'Published authored task · fixed task content'
    : 'Generated task · matched to the selected work setup';

  const renderPreparedTask = () => {
    if (!currentPreview) return null;
    return (
      <div className="assessment-prepared-task">
        <div className="assessment-task-source">
          <span>{taskOrigin}</span>
          <span className="assessment-task-status">
            {isCuratedPreview
              ? 'Published blueprint ready'
              : 'Sandbox validated'}
          </span>
        </div>
        <h3 ref={preparedTaskHeadingRef} tabIndex={-1}>
          {currentPreview.scenario.title}
        </h3>
        <p
          className="assessment-task-brief"
          data-expanded={briefExpanded}
          id="assessment-preview-brief"
        >
          {currentPreview.scenario.brief}
        </p>
        <button
          aria-controls="assessment-preview-brief"
          aria-expanded={briefExpanded}
          className="assessment-text-button"
          onClick={() =>
            setExpandedBriefId(
              briefExpanded
                ? null
                : (currentPreview.generatedAssessmentId ??
                    currentPreview.scenario.id),
            )
          }
          type="button"
        >
          {briefExpanded ? 'Show less' : 'Show full brief'}
        </button>
        <div className="assessment-task-facts">
          <span>
            {Math.round(currentPreview.scenario.durationSeconds / 60)} minutes
          </span>
          <span>{selectedStack}</span>
          <span>Terminal {currentPreview.terminalEnabled ? 'on' : 'off'}</span>
          <span>
            AI assistant{' '}
            {currentPreview.aiCapability.enabled ? 'available' : 'off'}
          </span>
        </div>
        <details className="assessment-disclosure">
          <summary>Expected behavior</summary>
          <ul>
            {currentPreview.scenario.acceptanceCriteria.map((criterion) => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ul>
        </details>
        {isCuratedPreview && !currentPreview.terminalEnabled ? (
          <p className="assessment-inline-warning" id="curated-terminal-help">
            The published blueprint requires Terminal so candidates can run
            pytest and record verification. Turn Terminal back on in Define
            before issuing it.
          </p>
        ) : null}
        {!currentPreview.terminalEnabled ? (
          <p className="assessment-capability-note">
            No candidate terminal verification will be available.
          </p>
        ) : null}
        {currentPreview.aiCapability.enabled ? (
          <p className="assessment-ai-note">
            Integrated AI is optional. Not using it is neutral.
          </p>
        ) : null}
      </div>
    );
  };

  const renderCandidateSummary = () => {
    if (!currentPreview) return null;
    return (
      <section
        className="assessment-candidate-summary"
        aria-labelledby="assessment-candidate-preview-title"
      >
        <div className="assessment-summary-heading">
          <div>
            <p className="assessment-kicker">Candidate will receive</p>
            <h3 id="assessment-candidate-preview-title">
              {currentPreview.scenario.title}
            </h3>
          </div>
          <span className="assessment-task-status">
            {isCuratedPreview ? 'Published blueprint' : 'Sandbox validated'}
          </span>
        </div>
        <p className="assessment-candidate-excerpt">
          {currentPreview.scenario.brief}
        </p>
        <div className="assessment-task-facts">
          <span>
            {Math.round(currentPreview.scenario.durationSeconds / 60)} minutes
          </span>
          <span>{selectedStack}</span>
          <span>Terminal {currentPreview.terminalEnabled ? 'on' : 'off'}</span>
          <span>
            AI assistant{' '}
            {currentPreview.aiCapability.enabled ? 'available' : 'off'}
          </span>
        </div>
        <details className="assessment-disclosure">
          <summary>Review full task brief and expected behavior</summary>
          <div className="assessment-candidate-full-brief">
            <p>{currentPreview.scenario.brief}</p>
            <ul>
              {currentPreview.scenario.acceptanceCriteria.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
          </div>
        </details>
        {isCuratedPreview ? (
          <p className="assessment-fixed-task-note">
            This is the published authored task. The work-context selections
            describe the assessment setup and do not change its task story.
          </p>
        ) : null}
      </section>
    );
  };

  const renderAssessmentContext = () => (
    <section
      className="assessment-issue-context"
      aria-label="Assessment context"
    >
      <p className="assessment-kicker">Work setup</p>
      <dl className="assessment-issue-facts">
        <div>
          <dt>Field</dt>
          <dd>{selectedField}</dd>
        </div>
        <div>
          <dt>Domain</dt>
          <dd>{selectedDomain}</dd>
        </div>
        <div>
          <dt>Challenge</dt>
          <dd>{selectedWorkKind}</dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>{selectedDepth}</dd>
        </div>
      </dl>
    </section>
  );

  const renderCreatedLink = () => {
    if (!created) return null;
    return (
      <div
        className="assessment-created"
        ref={createdStatusRef}
        role="status"
        tabIndex={-1}
      >
        <p className="assessment-kicker">
          {created.recovered ? 'Candidate link recovered' : 'Session issued'}
        </p>
        <h3>{created.scenario.title}</h3>
        <p>
          {created.recovered
            ? 'The original candidate session was recovered securely. Its lifecycle and evidence are unchanged.'
            : 'A candidate session has been created. The one-time link is shown here and was not sent by email.'}
        </p>
        <label className="assessment-link-label">
          Candidate link
          <input
            aria-label="Candidate link"
            onFocus={(event) => event.currentTarget.select()}
            readOnly
            ref={candidateLinkRef}
            value={new URL(
              created.candidatePath,
              window.location.origin,
            ).toString()}
          />
        </label>
        {error ? (
          <div
            className="assessment-feedback assessment-feedback-error"
            role="alert"
          >
            <p>{error}</p>
          </div>
        ) : null}
        <div className="assessment-created-buttons">
          <button
            className="assessment-secondary-button"
            onClick={() => void copyLink()}
            type="button"
          >
            {copied ? 'Copied' : 'Copy candidate link'}
          </button>
          <a
            className="assessment-primary-button"
            href={created.candidatePath}
            rel="noreferrer"
            target="_blank"
          >
            Open candidate link
          </a>
        </div>
        <Link
          className="assessment-lifecycle-link"
          href="/evaluator/assessments"
        >
          View candidate Lifecycle
        </Link>
        <small>Session {created.sessionId}</small>
        <button
          className="assessment-secondary-button"
          onClick={startNewAssessmentIntent}
          type="button"
        >
          Create another assessment
        </button>
      </div>
    );
  };

  const renderPendingIssuanceStatus = () => {
    if (!pendingIssuance && !pendingStorageUnavailable) return null;
    return (
      <div
        className="assessment-uncertain-issue"
        role={issuanceConflict ? 'alert' : 'status'}
        aria-live="polite"
      >
        <strong>
          {busy
            ? 'Issuance pending.'
            : issuanceConflict
              ? 'Request-key conflict.'
              : pendingStorageUnavailable
                ? 'Saved retry details are unavailable.'
                : issuanceRejected
                  ? 'Request was not accepted.'
                  : 'Issuance outcome is uncertain.'}
        </strong>
        <p>
          {busy
            ? 'The request key and exact assessment payload are saved in this tab before sending.'
            : issuanceConflict
              ? 'This key is bound to a different request. A new key may create an additional session if the earlier request was accepted.'
              : pendingStorageUnavailable
                ? 'Check Lifecycle before continuing. Starting a new assessment may create an additional session if the earlier request was accepted.'
                : issuanceRejected
                  ? 'The saved key and payload are retained. Restore evaluator access or resolve the request issue, then retry the same issuance. Starting with a new key may create an additional session if the earlier request was accepted.'
                  : 'Retry sends the same saved request key and payload to recover the original session and candidate link.'}
        </p>
        {!busy && pendingIssuance && !issuanceConflict ? (
          <button
            className="assessment-primary-button"
            onClick={() => void createAssessment()}
            type="button"
          >
            Retry same issuance
          </button>
        ) : null}
        {!busy &&
        (issuanceConflict || pendingStorageUnavailable || issuanceRejected) ? (
          <button
            className="assessment-primary-button"
            onClick={startNewAssessmentIntent}
            type="button"
          >
            Start a new assessment with a new key
          </button>
        ) : null}
        {!busy ? (
          <Link
            className="assessment-lifecycle-link"
            href="/evaluator/assessments"
          >
            Check candidate Lifecycle
          </Link>
        ) : null}
      </div>
    );
  };

  return (
    <div className="software-product assessment-builder-page">
      <SoftwareProductHeader active="assessments" />
      <main className="assessment-builder-shell">
        <div className="assessment-builder-container">
          <header className="assessment-builder-hero">
            <p className="assessment-eyebrow">
              Evaluator workspace <span aria-hidden="true">/</span> Assessments
            </p>
            <h1>Build an assessment</h1>
            <p>
              Define the work sample, validate a usable task, then issue one
              candidate session.
            </p>
          </header>
          {renderPendingIssuanceStatus()}

          <nav className="assessment-stage-nav" aria-label="Assessment stages">
            <ol>
              {builderStages.map((step, index) => {
                const caption =
                  step.stage === 'define'
                    ? saved
                      ? 'Draft saved'
                      : 'Work setup'
                    : step.stage === 'validate'
                      ? previewStateForSelection.kind === 'loading'
                        ? 'Preparing'
                        : currentPreview
                          ? isCuratedPreview
                            ? 'Blueprint ready'
                            : 'Validated'
                          : 'Task needed'
                      : created
                        ? 'Session issued'
                        : 'Review and share';
                return (
                  <li key={step.stage}>
                    <button
                      aria-current={stage === step.stage ? 'step' : undefined}
                      aria-label={`Go to ${step.label} stage`}
                      className="assessment-stage-button"
                      onClick={() => setStage(step.stage)}
                      type="button"
                    >
                      <span className="assessment-stage-number">
                        0{index + 1}
                      </span>
                      <span className="assessment-stage-label">
                        {step.label}
                      </span>
                      <span className="assessment-stage-caption">
                        {caption}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>

          <section
            className="assessment-stage-panel"
            aria-labelledby="assessment-stage-title"
            data-stage={stage}
          >
            <header className="assessment-stage-heading">
              <span className="assessment-stage-index">
                {activeStageCopy.number} <span aria-hidden="true">/ 03</span>
              </span>
              <div>
                <h2
                  id="assessment-stage-title"
                  ref={stageHeadingRef}
                  tabIndex={-1}
                >
                  {activeStageCopy.title}
                </h2>
                <p>{activeStageCopy.description}</p>
              </div>
            </header>

            {stage === 'define' ? (
              <div className="assessment-stage-content">
                {persistedDraft.error ? (
                  <div
                    className="assessment-feedback assessment-feedback-error"
                    role="alert"
                  >
                    {persistedDraft.error}
                  </div>
                ) : null}
                <section
                  className="assessment-section"
                  aria-labelledby="assessment-work-title"
                >
                  <div className="assessment-section-heading">
                    <div>
                      <h3 id="assessment-work-title">Work context</h3>
                      <p>
                        Describe the technical work and the kind of challenge.
                      </p>
                    </div>
                  </div>
                  <div className="assessment-fields-grid">
                    <div className="assessment-field">
                      <label htmlFor="assessment-field">Technical field</label>
                      <AssessmentChoice
                        id="assessment-field"
                        label="Technical field"
                        disabled={Boolean(created) || busy}
                        options={assessmentFields}
                        value={draft.field}
                        onChange={(value) => update('field', value)}
                        placeholder="Choose a technical field"
                      />
                    </div>
                    <div className="assessment-field">
                      <label htmlFor="assessment-stack">Stack</label>
                      <AssessmentChoice
                        id="assessment-stack"
                        label="Stack"
                        disabled={Boolean(created) || busy}
                        options={assessmentStacks.map((stackOption) => ({
                          ...stackOption,
                          label:
                            stackOption.id === 'python-flask'
                              ? stackOption.label
                              : `${stackOption.label} (not yet available)`,
                          disabled: stackOption.id !== 'python-flask',
                        }))}
                        value={draft.stack}
                        onChange={(value) => update('stack', value)}
                        placeholder="Choose a stack"
                      />
                    </div>
                    <div className="assessment-field">
                      <label htmlFor="assessment-domain">Domain</label>
                      <AssessmentChoice
                        id="assessment-domain"
                        label="Domain"
                        disabled={Boolean(created) || busy}
                        options={assessmentDomains}
                        value={draft.domain}
                        onChange={(value) => update('domain', value)}
                        placeholder="Choose a work context"
                      />
                    </div>
                    <div className="assessment-field">
                      <label htmlFor="assessment-challenge">Challenge</label>
                      <AssessmentChoice
                        id="assessment-challenge"
                        label="Challenge"
                        disabled={Boolean(created) || busy}
                        options={assessmentWorkKinds}
                        value={draft.workKind}
                        onChange={(value) => update('workKind', value)}
                        placeholder="Choose a challenge"
                      />
                    </div>
                    <div className="assessment-field">
                      <label htmlFor="assessment-depth">Scope</label>
                      <AssessmentChoice
                        id="assessment-depth"
                        label="Scope"
                        disabled={Boolean(created) || busy}
                        options={assessmentDepths}
                        value={draft.depth}
                        onChange={(value) => update('depth', value)}
                        placeholder="Choose a scope"
                      />
                    </div>
                  </div>
                  <p className="assessment-runtime-note">
                    <strong>Available runtime</strong>
                    <span>
                      Python · Flask is ready. Other catalog stacks remain
                      unavailable until their runtimes are supported.
                    </span>
                  </p>
                </section>

                <section
                  className="assessment-section assessment-conditions"
                  aria-labelledby="assessment-conditions-title"
                >
                  <div className="assessment-section-heading">
                    <div>
                      <h3 id="assessment-conditions-title">
                        Candidate conditions
                      </h3>
                      <p>
                        Choose a time budget. Tool settings stay visible in the
                        summary below.
                      </p>
                    </div>
                    <span className="assessment-selected-tools">
                      Terminal {draft.terminalEnabled ? 'on' : 'off'}{' '}
                      <span aria-hidden="true">·</span> AI{' '}
                      {draft.integratedAi ? 'on' : 'off'}
                    </span>
                  </div>
                  <fieldset className="assessment-duration-fieldset">
                    <legend>Candidate time budget</legend>
                    <div className="assessment-duration-options">
                      {assessmentDurations.map((minutes) => (
                        <label key={minutes}>
                          <input
                            checked={draft.durationMinutes === String(minutes)}
                            disabled={Boolean(created) || busy}
                            name="assessment-duration"
                            onChange={() =>
                              update('durationMinutes', String(minutes))
                            }
                            type="radio"
                            value={minutes}
                          />
                          <span>{minutes} min</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <details className="assessment-advanced-settings">
                    <summary>
                      Advanced settings <span>Terminal and integrated AI</span>
                    </summary>
                    <div className="assessment-tools-grid">
                      <label className="assessment-tool-toggle">
                        <span className="assessment-tool-copy">
                          <strong>Terminal</strong>
                          <small>
                            Command execution and recorded checks in the
                            candidate workspace.
                          </small>
                        </span>
                        <input
                          aria-label="Terminal"
                          checked={draft.terminalEnabled}
                          disabled={Boolean(created) || busy}
                          onChange={(event) =>
                            update('terminalEnabled', event.target.checked)
                          }
                          type="checkbox"
                        />
                      </label>
                      <label className="assessment-tool-toggle">
                        <span className="assessment-tool-copy">
                          <strong>Integrated AI</strong>
                          <small>
                            Recorded interactions remain neutral evidence; they
                            do not establish how submitted code was written.
                          </small>
                        </span>
                        <input
                          aria-label="Integrated AI"
                          checked={draft.integratedAi}
                          disabled={Boolean(created) || busy}
                          onChange={(event) =>
                            update('integratedAi', event.target.checked)
                          }
                          type="checkbox"
                        />
                      </label>
                    </div>
                    <p className="assessment-tool-availability">
                      Reference documentation and a browser tool are not
                      available in this workspace.
                    </p>
                  </details>
                </section>

                {generationBlocker ? (
                  <p
                    className="assessment-blocker"
                    id="assessment-generation-blocker"
                    role="status"
                  >
                    {generationBlocker}
                  </p>
                ) : null}
                {error ? (
                  <div
                    className="assessment-feedback assessment-feedback-error"
                    role="alert"
                  >
                    <p>{error}</p>
                    {requiresEvaluatorAccess ? (
                      <Link href="/evaluator">Open evaluator access</Link>
                    ) : null}
                  </div>
                ) : null}
                {saved ? (
                  <p className="assessment-saved" role="status">
                    Draft saved on this device.
                  </p>
                ) : null}
                <div className="assessment-stage-actions">
                  <Link
                    className="assessment-back-link"
                    href="/evaluator/assessments"
                  >
                    All assessments
                  </Link>
                  <div>
                    <button
                      className="assessment-secondary-button"
                      onClick={saveDraft}
                      type="button"
                    >
                      Save draft
                    </button>
                    <button
                      aria-describedby={
                        generationBlocker
                          ? 'assessment-generation-blocker'
                          : undefined
                      }
                      className="assessment-primary-button"
                      disabled={!isReady || Boolean(created) || busy}
                      onClick={() => setStage('validate')}
                      type="button"
                    >
                      Continue to Validate
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {stage === 'validate' ? (
              <div className="assessment-stage-content">
                {!currentPreview && generationBlocker ? (
                  <p
                    className="assessment-blocker"
                    id="assessment-generation-blocker"
                    role="status"
                  >
                    {generationBlocker}
                  </p>
                ) : null}
                {previewStateForSelection.kind === 'loading' ? (
                  <div
                    className="assessment-preparation-status"
                    role="status"
                    aria-live="polite"
                  >
                    <span className="assessment-status-mark" aria-hidden="true">
                      …
                    </span>
                    <div>
                      <strong>
                        {preparationMode === 'curated'
                          ? 'Loading the published task'
                          : 'Preparing and checking the task'}
                      </strong>
                      <p>
                        {preparationMode === 'curated'
                          ? 'The published authored task is fixed. Its task story does not change with the selected work context.'
                          : 'Generation and sandbox validation complete together. We’ll show the task only after the server returns a usable result.'}
                      </p>
                      {preparationMode === 'generated' ? (
                        <small
                          className="assessment-generation-elapsed"
                          role="timer"
                        >
                          Elapsed {formatElapsedSeconds(elapsedSeconds)}
                        </small>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {previewStateForSelection.kind === 'error' ? (
                  <div
                    className="assessment-feedback assessment-feedback-error"
                    role="alert"
                    ref={preparationFeedbackRef}
                    tabIndex={-1}
                  >
                    <div>
                      <strong>{previewErrorTitle}</strong>
                      <p>{previewStateForSelection.message}</p>
                    </div>
                    {previewStateForSelection.requiresEvaluatorAccess ? (
                      <Link
                        className="assessment-secondary-button"
                        href="/evaluator"
                      >
                        Open evaluator access
                      </Link>
                    ) : null}
                  </div>
                ) : null}
                {previewStateForSelection.kind === 'idle' ? (
                  <p className="assessment-intro-note">
                    Choose how to prepare the task. A candidate session stays
                    unavailable until the selected task is ready.
                  </p>
                ) : null}

                {currentPreview ? (
                  <>
                    {renderPreparedTask()}
                    <details className="assessment-alternative-source">
                      <summary>Choose a different task</summary>
                      <div className="assessment-preparation-options">
                        <article className="assessment-source-option">
                          <div className="assessment-source-heading">
                            <span className="assessment-source-tag">
                              Published · fixed
                            </span>
                            <span aria-hidden="true">01</span>
                          </div>
                          <h3>Use the authored task</h3>
                          <p>
                            Its task story remains the same regardless of
                            selected field, domain, challenge, or scope.
                            Terminal is required.
                          </p>
                          <button
                            aria-describedby={
                              !draft.terminalEnabled
                                ? 'assessment-curated-terminal-blocker'
                                : undefined
                            }
                            className="assessment-secondary-button"
                            disabled={
                              !isReady ||
                              (preparationMode === 'curated' &&
                                previewStateForSelection.kind === 'error' &&
                                !previewStateForSelection.retryable) ||
                              !draft.terminalEnabled ||
                              busy ||
                              Boolean(created)
                            }
                            onClick={() => void loadCuratedTask()}
                            type="button"
                          >
                            Load published task
                          </button>
                        </article>
                        <article className="assessment-source-option assessment-source-option-generated">
                          <div className="assessment-source-heading">
                            <span className="assessment-source-tag">
                              Provider · sandbox checked
                            </span>
                            <span aria-hidden="true">02</span>
                          </div>
                          <h3>Generate from this setup</h3>
                          <p>
                            Uses the selected technical field, stack, domain,
                            challenge, and scope. The server validates the
                            generated task before it can be issued.
                          </p>
                          <button
                            className="assessment-secondary-button"
                            disabled={
                              !isReady ||
                              (preparationMode === 'generated' &&
                                previewStateForSelection.kind === 'error' &&
                                !previewStateForSelection.retryable) ||
                              busy ||
                              Boolean(created) ||
                              (previewStateForSelection.kind === 'error' &&
                                previewStateForSelection.requiresEvaluatorAccess)
                            }
                            onClick={prepareTask}
                            type="button"
                          >
                            Generate another task
                          </button>
                        </article>
                      </div>
                    </details>
                    {error ? (
                      <div
                        className="assessment-feedback assessment-feedback-error"
                        role="alert"
                      >
                        <p>{error}</p>
                        {requiresEvaluatorAccess ? (
                          <Link href="/evaluator">Open evaluator access</Link>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="assessment-stage-actions">
                      <button
                        className="assessment-secondary-button"
                        onClick={() => setStage('define')}
                        type="button"
                      >
                        Back to Define
                      </button>
                      <button
                        className="assessment-primary-button"
                        onClick={() => setStage('issue')}
                        type="button"
                      >
                        Continue to Issue
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    {previewStateForSelection.kind !== 'loading' ? (
                      <div className="assessment-preparation-options">
                        <article className="assessment-source-option">
                          <div className="assessment-source-heading">
                            <span className="assessment-source-tag">
                              Published · fixed
                            </span>
                            <span aria-hidden="true">01</span>
                          </div>
                          <h3>Use the authored task</h3>
                          <p>
                            Loads the currently published task. Its task story
                            does not change with field, domain, challenge, or
                            scope. Terminal is required.
                          </p>
                          {!draft.terminalEnabled ? (
                            <p
                              className="assessment-inline-warning"
                              id="assessment-curated-terminal-blocker"
                            >
                              Turn Terminal on in Define to use this blueprint.
                            </p>
                          ) : null}
                          <button
                            aria-describedby={
                              !isReady
                                ? 'assessment-generation-blocker'
                                : !draft.terminalEnabled
                                  ? 'assessment-curated-terminal-blocker'
                                  : undefined
                            }
                            className="assessment-secondary-button"
                            disabled={
                              !isReady ||
                              (preparationMode === 'curated' &&
                                previewStateForSelection.kind === 'error' &&
                                !previewStateForSelection.retryable) ||
                              !draft.terminalEnabled ||
                              busy ||
                              Boolean(created)
                            }
                            onClick={() => void loadCuratedTask()}
                            type="button"
                          >
                            {preparationMode === 'curated' &&
                            previewStateForSelection.kind === 'error'
                              ? 'Retry published task'
                              : 'Load published task'}
                          </button>
                        </article>
                        <article className="assessment-source-option assessment-source-option-generated">
                          <div className="assessment-source-heading">
                            <span className="assessment-source-tag">
                              Provider · sandbox checked
                            </span>
                            <span aria-hidden="true">02</span>
                          </div>
                          <h3>Generate from this setup</h3>
                          <p>
                            Uses the selected technical field, stack, domain,
                            challenge, and scope. Generation and sandbox
                            validation return as one server result.
                          </p>
                          <button
                            aria-describedby={
                              !isReady
                                ? 'assessment-generation-blocker'
                                : undefined
                            }
                            className="assessment-primary-button"
                            disabled={
                              !isReady ||
                              (preparationMode === 'generated' &&
                                previewStateForSelection.kind === 'error' &&
                                !previewStateForSelection.retryable) ||
                              busy ||
                              Boolean(created) ||
                              (previewStateForSelection.kind === 'error' &&
                                previewStateForSelection.requiresEvaluatorAccess)
                            }
                            onClick={prepareTask}
                            type="button"
                          >
                            {previewStateForSelection.kind === 'error' &&
                            preparationMode === 'generated'
                              ? 'Retry generation'
                              : 'Generate and validate task'}
                          </button>
                        </article>
                      </div>
                    ) : null}
                    <div className="assessment-stage-actions">
                      <button
                        className="assessment-secondary-button"
                        onClick={() => setStage('define')}
                        type="button"
                      >
                        Back to Define
                      </button>
                      <p>
                        {generationBlocker ??
                          'Prepare a task before continuing to Issue.'}
                      </p>
                    </div>
                  </>
                )}
              </div>
            ) : null}

            {stage === 'issue' ? (
              <div className="assessment-stage-content">
                {created ? renderCreatedLink() : null}
                {!currentPreview ? (
                  created || hasUnresolvedIssuance ? null : (
                    <div className="assessment-empty-stage">
                      <span
                        className="assessment-empty-stage-mark"
                        aria-hidden="true"
                      >
                        02
                      </span>
                      <div>
                        <p className="assessment-kicker">Validation required</p>
                        <h3>Prepare a task before issuing</h3>
                        <p>
                          {generationBlocker ??
                            'A task must return successfully from the selected preparation route before a candidate session can be created.'}
                        </p>
                        <button
                          className="assessment-primary-button"
                          onClick={() => setStage('validate')}
                          type="button"
                        >
                          Go to Validate
                        </button>
                      </div>
                    </div>
                  )
                ) : (
                  <>
                    {created ? (
                      <>
                        <details className="assessment-issued-details">
                          <summary>Review the issued task and settings</summary>
                          {renderCandidateSummary()}
                          {renderAssessmentContext()}
                          <details
                            className="assessment-rubric-disclosure"
                            open={!rubricWeightsValid}
                          >
                            <summary>
                              <span>Review rubric and recommendations</span>
                              <span className="assessment-rubric-summary-state">
                                {rubricWeightTotal}%
                                {rubricWeightsValid
                                  ? ''
                                  : ' · needs adjustment'}
                              </span>
                            </summary>
                            <AssessmentRubric
                              currentPreview={currentPreview}
                              previewState={previewStateForSelection}
                              rubricWeightTotal={rubricWeightTotal}
                              rubricWeightsValid={rubricWeightsValid}
                              busy={busy}
                              created={Boolean(created)}
                              draft={draft}
                              onUpdate={update}
                            />
                          </details>
                        </details>
                      </>
                    ) : (
                      <>
                        {renderCandidateSummary()}
                        {renderAssessmentContext()}
                        <details
                          className="assessment-rubric-disclosure"
                          open={!rubricWeightsValid}
                        >
                          <summary>
                            <span>Review rubric and recommendations</span>
                            <span className="assessment-rubric-summary-state">
                              {rubricWeightTotal}%
                              {rubricWeightsValid ? '' : ' · needs adjustment'}
                            </span>
                          </summary>
                          <AssessmentRubric
                            currentPreview={currentPreview}
                            previewState={previewStateForSelection}
                            rubricWeightTotal={rubricWeightTotal}
                            rubricWeightsValid={rubricWeightsValid}
                            busy={busy}
                            created={Boolean(created)}
                            draft={draft}
                            onUpdate={update}
                          />
                        </details>
                        {curatedTerminalBlocker ? (
                          <div
                            className="assessment-feedback assessment-feedback-warning"
                            role="status"
                          >
                            <p>
                              The authored blueprint requires Terminal for
                              candidate verification.
                            </p>
                            <button
                              className="assessment-text-button"
                              onClick={() => setStage('define')}
                              type="button"
                            >
                              Turn Terminal back on
                            </button>
                          </div>
                        ) : null}
                        {error ? (
                          <div
                            className="assessment-feedback assessment-feedback-error"
                            role="alert"
                          >
                            <p>{error}</p>
                            {requiresEvaluatorAccess ? (
                              <Link href="/evaluator">
                                Open evaluator access
                              </Link>
                            ) : null}
                          </div>
                        ) : null}
                        {hasUnresolvedIssuance ||
                        issuanceConflict ||
                        pendingStorageUnavailable ? null : (
                          <div className="assessment-stage-actions assessment-issue-actions">
                            <button
                              className="assessment-secondary-button"
                              onClick={() => setStage('validate')}
                              type="button"
                            >
                              Back to Validate
                            </button>
                            <div>
                              <p
                                id="assessment-issue-blocker"
                                className="assessment-action-hint"
                                role="status"
                              >
                                {curatedTerminalBlocker
                                  ? 'Turn Terminal on in Define before issuing this authored task.'
                                  : !rubricWeightsValid
                                    ? 'Adjust the rubric weights to total 100% before issuing.'
                                    : error
                                      ? 'Review the message above before trying again.'
                                      : canIssue
                                        ? 'The prepared task and rubric are ready to issue.'
                                        : 'The task and rubric must be ready before a candidate session can be created.'}
                              </p>
                              <button
                                aria-describedby="assessment-issue-blocker"
                                className="assessment-primary-button"
                                disabled={!canIssue}
                                onClick={() => void createAssessment()}
                                type="button"
                              >
                                {busy
                                  ? 'Creating candidate session…'
                                  : 'Create candidate link'}
                              </button>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            ) : null}
          </section>
        </div>
      </main>
    </div>
  );
};
