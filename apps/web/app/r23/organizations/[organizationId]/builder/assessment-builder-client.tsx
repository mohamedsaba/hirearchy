'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type {
  R23CandidateInvitationResponse,
  R23CandidateInvitationRevocationResponse,
} from '../../../../../src/r23-auth/contract';
import type {
  R211AssessmentDraft,
  R211StarterFile,
  R211RubricCriterion,
  R211ValidationIssue,
  R211ValidatedVersion,
} from '../../../../../src/r211-builder/contract';
import {
  formatDigestBadge,
  formatFullDigest,
  EXECUTION_VALIDATION_NOTICE,
  CONCURRENCY_CONFLICT_BANNER,
  DRAFT_SAVED_MESSAGE,
  VALIDATION_FAILED_MESSAGE,
} from '../../../../../src/r211-builder/presentation';

import '../../../../evaluator/assessments/new/assessment-builder.css';
import '../../../../evaluator/assessments/new/assessment-choice.css';
import '../../../../evaluator/evaluator-product.css';

export interface AssessmentBuilderReviewerOption {
  principalId: string;
  role: string;
  joinedAt?: string;
  displayName?: string | null;
  email?: string | null;
}

export function AssessmentReviewerOptions({
  reviewers,
}: Readonly<{ reviewers: AssessmentBuilderReviewerOption[] }>) {
  return reviewers.map((reviewer) => {
    const identityLabel = [reviewer.displayName?.trim(), reviewer.email?.trim()]
      .filter((value): value is string => Boolean(value))
      .join(' · ');
    return (
      <option key={reviewer.principalId} value={reviewer.principalId}>
        {identityLabel || reviewer.principalId} ({reviewer.role})
      </option>
    );
  });
}

export interface AssessmentBuilderClientProps {
  organizationId: string;
  csrfToken: string;
  initialDraft: R211AssessmentDraft | null;
  initialIssuedSessionId?: string | null;
  reviewers?: AssessmentBuilderReviewerOption[];
  isAuthenticatedStaging?: boolean;
}

type BuilderStage = 'define' | 'validate' | 'issue';

type InvitationCreateIntent = Readonly<{
  idempotencyKey: string;
  expiresAt: string;
}>;

const defaultInvitationLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const maxInvitationLifetimeMs = 30 * 24 * 60 * 60 * 1000;

function toLocalDateTimeInput(date: Date): string {
  const localDate = new Date(
    date.getTime() - date.getTimezoneOffset() * 60_000,
  );
  return localDate.toISOString().slice(0, 16);
}

function formatInvitationTime(value: string | null): string {
  if (!value) return 'time unavailable';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString()
    : 'time unavailable';
}

function absoluteInvitationUrl(path: string, origin: string): string | null {
  try {
    const url = new URL(path, origin);
    return url.origin === origin ? url.toString() : null;
  } catch {
    return null;
  }
}

const defaultStarterFiles: R211StarterFile[] = [
  {
    path: 'booking.py',
    content: '# Primary booking implementation\ndef book():\n    pass\n',
  },
  {
    path: 'README.md',
    content: '# Challenge Instructions\nFollow candidate brief.\n',
  },
  {
    path: 'tests/test_booking.py',
    content:
      'import unittest\n\nclass TestBooking(unittest.TestCase):\n    pass\n',
  },
];

const defaultRubric: R211RubricCriterion[] = [
  {
    id: 'correctness',
    label: 'Correctness',
    description: 'Handles retries and error conditions correctly.',
    weight: 60,
    applicability: {
      kind: 'always',
      rule: 'Applies to all candidate submissions',
    },
  },
  {
    id: 'code-quality',
    label: 'Code Quality',
    description: 'Clean, idiomatic code and error logging.',
    weight: 40,
    applicability: {
      kind: 'always',
      rule: 'Applies to all candidate submissions',
    },
  },
];

export function AssessmentBuilderClient({
  organizationId,
  csrfToken,
  initialDraft,
  initialIssuedSessionId = null,
  reviewers = [],
  isAuthenticatedStaging = false,
}: AssessmentBuilderClientProps) {
  const [stage, setStage] = useState<BuilderStage>(
    isAuthenticatedStaging && initialIssuedSessionId ? 'issue' : 'define',
  );

  // Draft state
  const [definitionId, setDefinitionId] = useState<string | undefined>(
    initialDraft?.definitionId,
  );
  const [draftVersion, setDraftVersion] = useState<number>(
    initialDraft?.version ?? 1,
  );
  const [templateId, setTemplateId] = useState<
    'custom' | 'reservation-moves-v3'
  >(
    initialDraft
      ? (initialDraft.templateId ?? 'custom')
      : 'reservation-moves-v3',
  );
  const [title, setTitle] = useState(
    initialDraft?.title ?? 'Booking Notification Retry Logic',
  );
  const [brief, setBrief] = useState(
    initialDraft?.brief ??
      'Implement retry logic with exponential backoff for the notification dispatch service.',
  );
  const [expectedBehavior, setExpectedBehavior] = useState<string[]>(
    initialDraft?.expectedBehavior && initialDraft.expectedBehavior.length > 0
      ? [...initialDraft.expectedBehavior]
      : [
          'Retries transient connection errors up to 3 times',
          'Logs retry attempt with sequence and delay',
        ],
  );
  const [acceptanceCriteria, setAcceptanceCriteria] = useState<string[]>(
    initialDraft?.acceptanceCriteria &&
      initialDraft.acceptanceCriteria.length > 0
      ? [...initialDraft.acceptanceCriteria]
      : [
          'All tests in tests/test_booking.py pass cleanly',
          'No unhandled connection timeout exceptions raised',
        ],
  );
  const [primaryFilePath, setPrimaryFilePath] = useState(
    initialDraft?.primaryFilePath ?? 'booking.py',
  );
  const [starterFiles, setStarterFiles] = useState<R211StarterFile[]>(
    initialDraft?.starterFiles && initialDraft.starterFiles.length > 0
      ? [...initialDraft.starterFiles]
      : defaultStarterFiles,
  );
  const [durationMinutes, setDurationMinutes] = useState<number>(
    initialDraft?.durationMinutes ?? 45,
  );
  const [terminalEnabled, setTerminalEnabled] = useState<boolean>(
    initialDraft?.terminalEnabled ?? true,
  );
  const [integratedAi, setIntegratedAi] = useState<boolean>(
    initialDraft?.integratedAi ?? false,
  );
  const [rubric, setRubric] = useState<R211RubricCriterion[]>(
    initialDraft?.rubric && initialDraft.rubric.length > 0
      ? [...initialDraft.rubric]
      : defaultRubric,
  );

  // Status & communication states
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<
    'idle' | 'saved' | 'conflict' | 'error'
  >('idle');
  const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null);

  // Validation state
  const [isValidating, setIsValidating] = useState(false);
  const [validationIssues, setValidationIssues] = useState<
    R211ValidationIssue[]
  >([]);
  const [validationErrorMessage, setValidationErrorMessage] = useState<
    string | null
  >(null);
  const [validatedVersion, setValidatedVersion] =
    useState<R211ValidatedVersion | null>(null);

  // Issuance state
  const [selectedReviewerPrincipalId, setSelectedReviewerPrincipalId] =
    useState<string>(reviewers[0]?.principalId ?? '');
  const effectiveReviewerPrincipalId =
    selectedReviewerPrincipalId || reviewers[0]?.principalId || '';
  const [isIssuing, setIsIssuing] = useState(false);
  const [issuedSession, setIssuedSession] = useState<{
    sessionId: string;
    candidatePath: string | null;
    reviewerPrincipalId?: string | null;
    candidateTokenIssued?: boolean;
  } | null>(null);
  const [recoveryContext, setRecoveryContext] = useState(() => {
    let sessionId: string | null = null;
    let error: string | null = null;
    if (isAuthenticatedStaging && typeof initialIssuedSessionId === 'string') {
      if (/^sess_[A-Za-z0-9_-]{1,128}$/.test(initialIssuedSessionId)) {
        sessionId = initialIssuedSessionId;
      } else {
        error =
          'This saved session reference is not valid. Return to the organization workspace and open an issued session again.';
      }
    }
    return {
      organizationId,
      assessmentId: initialDraft?.definitionId ?? null,
      sessionId,
      error,
    };
  });
  const [issuanceError, setIssuanceError] = useState<string | null>(null);
  const [invitationState, setInvitationState] = useState<{
    contextKey: string;
    invitation: R23CandidateInvitationResponse;
  } | null>(null);
  const [invitationLoadedContextKey, setInvitationLoadedContextKey] =
    useState('');
  const [invitationBusyOperations, setInvitationBusyOperations] = useState<
    { contextKey: string; operationId: number }[]
  >([]);
  const [invitationExpiresAtInput, setInvitationExpiresAtInput] = useState('');
  const [invitationExpiryMin, setInvitationExpiryMin] = useState('');
  const [invitationExpiryMax, setInvitationExpiryMax] = useState('');
  const invitationExpiryContextRef = useRef('');
  const [invitationExpiryError, setInvitationExpiryError] = useState<
    string | null
  >(null);
  const [invitationError, setInvitationError] = useState<string | null>(null);
  const [invitationMessage, setInvitationMessage] = useState<string | null>(
    null,
  );
  const [invitationRetryState, setInvitationRetryState] = useState<{
    contextKey: string;
    pending: boolean;
  } | null>(null);
  const [invitationNeedsRefresh, setInvitationNeedsRefresh] = useState(false);
  const [invitationRefreshVersion, setInvitationRefreshVersion] = useState(0);
  const invitationCreateIntentsRef = useRef(
    new Map<string, InvitationCreateIntent>(),
  );
  const [appOrigin, setAppOrigin] = useState('');
  const [invitationCopyMessage, setInvitationCopyMessage] = useState<
    string | null
  >(null);
  const [invitationFeedbackContextKey, setInvitationFeedbackContextKey] =
    useState('');
  const invitationOperationIdRef = useRef(0);

  const [idempotencyKey] = useState(
    () => `r211-issue-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );
  const currentAssessmentId = initialDraft?.definitionId ?? null;
  const recoveryContextIsCurrent =
    recoveryContext.organizationId === organizationId &&
    recoveryContext.assessmentId === currentAssessmentId;
  const recoveredSessionId = recoveryContextIsCurrent
    ? recoveryContext.sessionId
    : null;
  const recoveryContextError = recoveryContextIsCurrent
    ? recoveryContext.error
    : null;
  const currentSessionId = issuedSession?.sessionId ?? recoveredSessionId;
  const invitationContextKey = `${organizationId}\u0000${currentAssessmentId ?? ''}\u0000${currentSessionId ?? ''}`;
  const invitation =
    invitationState?.contextKey === invitationContextKey
      ? invitationState.invitation
      : null;
  const invitationFeedbackIsCurrent =
    invitationFeedbackContextKey === invitationContextKey;
  const currentInvitationError = invitationFeedbackIsCurrent
    ? invitationError
    : null;
  const currentInvitationMessage = invitationFeedbackIsCurrent
    ? invitationMessage
    : null;
  const currentInvitationCopyMessage = invitationFeedbackIsCurrent
    ? invitationCopyMessage
    : null;
  const currentInvitationNeedsRefresh = invitationFeedbackIsCurrent
    ? invitationNeedsRefresh
    : false;
  const currentInvitationRetryPending = invitationFeedbackIsCurrent
    ? invitationRetryState?.contextKey === invitationContextKey &&
      invitationRetryState.pending
    : false;
  const currentInvitationBusy = invitationFeedbackIsCurrent
    ? invitationBusyOperations.some(
        (operation) => operation.contextKey === invitationContextKey,
      )
    : false;
  const invitationLoading = Boolean(
    isAuthenticatedStaging &&
    currentSessionId &&
    invitationLoadedContextKey !== invitationContextKey,
  );
  const setInvitation = (value: R23CandidateInvitationResponse) =>
    setInvitationState({ contextKey: invitationContextKey, invitation: value });
  const beginInvitationOperation = (contextKey: string) => {
    const operationId = ++invitationOperationIdRef.current;
    setInvitationBusyOperations((current) => [
      ...current,
      { contextKey, operationId },
    ]);
    return operationId;
  };
  const finishInvitationOperation = (
    contextKey: string,
    operationId: number,
  ) => {
    setInvitationBusyOperations((current) =>
      current.filter(
        (operation) =>
          operation.contextKey !== contextKey ||
          operation.operationId !== operationId,
      ),
    );
  };
  const setInvitationRetryPendingForContext = (
    contextKey: string,
    pending: boolean,
  ) => {
    setInvitationRetryState((current) =>
      pending
        ? { contextKey, pending: true }
        : current?.contextKey === contextKey
          ? null
          : current,
    );
  };
  const initializeInvitationExpiry = useCallback(
    (contextKey: string, expiresAt: string | null) => {
      const now = new Date();
      const defaultExpiry = new Date(
        now.getTime() + defaultInvitationLifetimeMs,
      );
      const maxExpiry = new Date(now.getTime() + maxInvitationLifetimeMs);
      setInvitationExpiryMin(toLocalDateTimeInput(now));
      setInvitationExpiryMax(toLocalDateTimeInput(maxExpiry));
      setInvitationExpiresAtInput(
        toLocalDateTimeInput(expiresAt ? new Date(expiresAt) : defaultExpiry),
      );
      setInvitationExpiryError(null);
      invitationExpiryContextRef.current = contextKey;
    },
    [],
  );
  const invitationContextRef = useRef({
    key: invitationContextKey,
    generation: 0,
  });

  useLayoutEffect(() => {
    if (invitationContextRef.current.key === invitationContextKey) return;
    invitationContextRef.current = {
      key: invitationContextKey,
      generation: invitationContextRef.current.generation + 1,
    };
  }, [invitationContextKey]);

  useEffect(() => {
    const sessionId = currentSessionId;
    if (!sessionId) return;

    let active = true;
    const contextKey = invitationContextKey;
    const endpoint = `/r23/api/organizations/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(sessionId)}/candidate-token`;

    void fetch(endpoint, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            response.status === 401 ||
              response.status === 403 ||
              response.status === 404
              ? 'SESSION_UNAVAILABLE'
              : `HTTP ${response.status}`,
          );
        }
        const data = await response.json();
        if (data.sessionId && data.sessionId !== sessionId) {
          throw new Error('SESSION_MISMATCH');
        }
        const result: R23CandidateInvitationResponse =
          typeof data.candidateToken === 'string'
            ? {
                sessionId,
                status: 'active',
                candidatePath: `/r26/candidate/${sessionId}#${data.candidateToken}`,
                expiresAt: data.expiresAt ?? null,
              }
            : data;
        if (active) {
          setInvitationState({ contextKey, invitation: result });
          setInvitationFeedbackContextKey(contextKey);
          setInvitationNeedsRefresh(false);
          setInvitationError(null);
          setInvitationMessage(null);
          setInvitationCopyMessage(null);
          setInvitationExpiryError(null);
          setAppOrigin(window.location.origin);
          if (invitationExpiryContextRef.current !== contextKey) {
            const unresolvedIntent =
              invitationCreateIntentsRef.current.get(contextKey);
            initializeInvitationExpiry(
              contextKey,
              result.status === 'not_created'
                ? (unresolvedIntent?.expiresAt ?? null)
                : result.expiresAt,
            );
          }
          if (result.status === 'not_created') {
            const unresolvedIntent =
              invitationCreateIntentsRef.current.get(contextKey);
            setInvitationRetryPendingForContext(
              contextKey,
              unresolvedIntent !== undefined,
            );
            if (unresolvedIntent) {
              setInvitationExpiresAtInput(
                toLocalDateTimeInput(new Date(unresolvedIntent.expiresAt)),
              );
            }
          } else {
            invitationCreateIntentsRef.current.delete(contextKey);
            setInvitationRetryPendingForContext(contextKey, false);
          }
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setInvitationFeedbackContextKey(contextKey);
          setInvitationError(
            error instanceof Error && error.message === 'SESSION_UNAVAILABLE'
              ? 'This issued session is not available in this organization, or your access has changed. The assessment draft is preserved; no new session was issued.'
              : error instanceof Error && error.message === 'SESSION_MISMATCH'
                ? 'The issued session reference could not be confirmed. The assessment draft is preserved; no invitation link was shared.'
                : 'Invitation status could not be loaded. Check it again before creating or sharing a link.',
          );
          setInvitationNeedsRefresh(true);
        }
      })
      .finally(() => {
        if (active) setInvitationLoadedContextKey(contextKey);
      });

    return () => {
      active = false;
    };
  }, [
    currentSessionId,
    invitationContextKey,
    invitationRefreshVersion,
    isAuthenticatedStaging,
    initializeInvitationExpiry,
    organizationId,
  ]);

  // Rubric weights sum
  const rubricTotalWeight = rubric.reduce(
    (sum, crit) => sum + (Number.isInteger(crit.weight) ? crit.weight : 0),
    0,
  );

  // Helper to get issue for specific field
  const getFieldIssue = (fieldName: string) => {
    return validationIssues.find((issue) => issue.field === fieldName)?.message;
  };

  // Save Draft Action
  const handleSaveDraft = async () => {
    setIsSaving(true);
    setSaveStatus('idle');
    setSaveErrorMessage(null);

    const payload = {
      templateId,
      definitionId,
      title,
      brief,
      expectedBehavior,
      acceptanceCriteria,
      primaryFilePath,
      starterFiles,
      durationMinutes,
      terminalEnabled,
      integratedAi,
      rubric,
      expectedVersion: draftVersion,
      csrf: csrfToken,
    };

    try {
      const response = await fetch(
        `/r23/api/organizations/${encodeURIComponent(organizationId)}/assessments/draft`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': csrfToken,
            Origin: window.location.origin,
          },
          body: JSON.stringify(payload),
        },
      );

      if (response.status === 409) {
        setSaveStatus('conflict');
        setSaveErrorMessage(CONCURRENCY_CONFLICT_BANNER);
        return;
      }

      if (!response.ok) {
        const errJson = await response.json().catch(() => null);
        setSaveStatus('error');
        setSaveErrorMessage(
          errJson?.error?.message ??
            `Failed to save draft (${response.status})`,
        );
        return;
      }

      const data = await response.json();
      if (data?.draft) {
        setDefinitionId(data.draft.definitionId);
        setDraftVersion(data.draft.version);
      }
      setSaveStatus('saved');
    } catch (err: unknown) {
      setSaveStatus('error');
      setSaveErrorMessage(
        err instanceof Error
          ? err.message
          : 'Network error while saving draft.',
      );
    } finally {
      setIsSaving(false);
    }
  };

  // Validate Action
  const handleValidate = async () => {
    setIsValidating(true);
    setValidationIssues([]);
    setValidationErrorMessage(null);

    const payload = {
      templateId,
      definitionId,
      title,
      brief,
      expectedBehavior,
      acceptanceCriteria,
      primaryFilePath,
      starterFiles,
      durationMinutes,
      terminalEnabled,
      integratedAi,
      rubric,
      expectedDraftVersion: draftVersion,
      csrf: csrfToken,
    };

    try {
      const response = await fetch(
        `/r23/api/organizations/${encodeURIComponent(organizationId)}/assessments/validate`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': csrfToken,
            Origin: window.location.origin,
          },
          body: JSON.stringify(payload),
        },
      );

      const data = await response.json().catch(() => null);

      if (response.status === 422 || data?.valid === false) {
        setValidationIssues(data?.issues ?? []);
        setValidationErrorMessage(
          data?.issues?.[0]?.message ?? VALIDATION_FAILED_MESSAGE,
        );
        return;
      }

      if (!response.ok || !data?.version) {
        setValidationErrorMessage(
          data?.error?.message ??
            `Validation failed with status ${response.status}`,
        );
        return;
      }

      // Validated successfully
      setValidatedVersion(data.version);
      if (data?.draft) {
        setDefinitionId(data.draft.definitionId);
        setDraftVersion(data.draft.version);
      }
      setSaveStatus('idle');
      setValidationIssues([]);
      setValidationErrorMessage(null);
    } catch (err: unknown) {
      setValidationErrorMessage(
        err instanceof Error
          ? err.message
          : 'Network error validating assessment.',
      );
    } finally {
      setIsValidating(false);
    }
  };

  // Issue Action
  const handleIssue = async () => {
    if (!validatedVersion) return;
    if (isAuthenticatedStaging && !effectiveReviewerPrincipalId) {
      setIssuanceError(
        'Select an active organization reviewer to assign before issuing the assessment.',
      );
      return;
    }
    setIsIssuing(true);
    setIssuanceError(null);

    try {
      const response = await fetch(
        `/r23/api/organizations/${encodeURIComponent(organizationId)}/sessions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': csrfToken,
            Origin: window.location.origin,
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify({
            validatedVersionId: validatedVersion.id,
            scenarioId: validatedVersion.scenarioId || validatedVersion.id,
            durationMinutes: Math.round(validatedVersion.durationSeconds / 60),
            terminalEnabled: validatedVersion.terminalEnabled,
            integratedAi: validatedVersion.integratedAi,
            ...(effectiveReviewerPrincipalId
              ? { reviewerPrincipalId: effectiveReviewerPrincipalId }
              : {}),
            idempotencyKey,
            csrf: csrfToken,
          }),
        },
      );

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        setIssuanceError(
          data?.error?.message ??
            `Failed to issue assessment (${response.status})`,
        );
        return;
      }

      if (
        typeof data?.sessionId !== 'string' ||
        !/^sess_[A-Za-z0-9_-]{1,128}$/.test(data.sessionId)
      ) {
        setIssuanceError(
          'The assessment was issued, but its session reference could not be confirmed. Reload the organization session list before continuing.',
        );
        return;
      }

      if (isAuthenticatedStaging) {
        const url = new URL(window.location.href);
        url.searchParams.set('issuedSession', data.sessionId);
        window.history.replaceState(window.history.state, '', url);
      }
      setRecoveryContext({
        organizationId,
        assessmentId: currentAssessmentId,
        sessionId: null,
        error: null,
      });

      setIssuedSession({
        sessionId: data.sessionId,
        candidatePath:
          data.candidatePath === null
            ? null
            : (data.candidatePath ?? `/r26/candidate/${data.sessionId}`),
        reviewerPrincipalId:
          data.reviewerPrincipalId ?? (selectedReviewerPrincipalId || null),
        candidateTokenIssued:
          typeof data.candidateTokenIssued === 'boolean'
            ? data.candidateTokenIssued
            : data.candidatePath !== null,
      });

      if (!isAuthenticatedStaging && selectedReviewerPrincipalId) {
        void fetch(
          `/r23/api/organizations/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(data.sessionId)}/assignments`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-csrf-token': csrfToken,
              Origin: window.location.origin,
            },
            body: JSON.stringify({
              reviewerPrincipalId: selectedReviewerPrincipalId,
              csrf: csrfToken,
            }),
          },
        );
      }
    } catch (err: unknown) {
      setIssuanceError(
        err instanceof Error
          ? err.message
          : 'Network error issuing assessment.',
      );
    } finally {
      setIsIssuing(false);
    }
  };

  const clearRecoveredSessionContext = () => {
    if (issuedSession) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('issuedSession');
    window.history.replaceState(window.history.state, '', url);
    setRecoveryContext({
      organizationId,
      assessmentId: currentAssessmentId,
      sessionId: null,
      error: null,
    });
    setInvitationError(null);
    setInvitationMessage(null);
    setInvitationFeedbackContextKey(invitationContextKey);
    setInvitationNeedsRefresh(false);
  };

  const navigateToDefine = () => {
    clearRecoveredSessionContext();
    setStage('define');
  };

  const refreshInvitationStatus = () => {
    if (!currentSessionId) return;
    setInvitationFeedbackContextKey(invitationContextKey);
    setInvitationLoadedContextKey('');
    setInvitationNeedsRefresh(true);
    setInvitationRefreshVersion((version) => version + 1);
  };

  const confirmedCandidatePathFor = (sessionId: string | null) => {
    if (
      !sessionId ||
      invitation?.sessionId !== sessionId ||
      invitation.status !== 'active' ||
      !invitation.candidatePath ||
      currentInvitationNeedsRefresh ||
      currentInvitationBusy
    ) {
      return null;
    }
    return invitation.candidatePath;
  };

  const createCandidateInvitation = async () => {
    const sessionId = currentSessionId;
    if (
      !isAuthenticatedStaging ||
      !sessionId ||
      currentInvitationBusy ||
      invitationLoading ||
      !invitation ||
      invitation.sessionId !== sessionId ||
      (invitation.status !== 'not_created' && !currentInvitationRetryPending)
    ) {
      return;
    }
    setInvitationFeedbackContextKey(invitationContextKey);

    const operationGeneration = invitationContextRef.current.generation;
    const isCurrentContext = () =>
      invitationContextRef.current.generation === operationGeneration;

    let intent = invitationCreateIntentsRef.current.get(invitationContextKey);
    if (!intent) {
      const expiryMs = Date.parse(invitationExpiresAtInput);
      const now = Date.now();
      if (!Number.isFinite(expiryMs)) {
        setInvitationExpiryError('Choose an invitation expiry time.');
        return;
      }
      if (expiryMs <= now) {
        setInvitationExpiryError('Choose a time in the future.');
        return;
      }
      if (expiryMs > now + maxInvitationLifetimeMs) {
        setInvitationExpiryError(
          'Choose an expiry no more than 30 days from now.',
        );
        return;
      }
      intent = {
        idempotencyKey: `r23-invitation-${crypto.randomUUID()}`,
        expiresAt: new Date(expiryMs).toISOString(),
      };
      invitationCreateIntentsRef.current.set(invitationContextKey, intent);
    }

    const endpoint = `/r23/api/organizations/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(sessionId)}/candidate-token`;
    setInvitationFeedbackContextKey(invitationContextKey);
    const busyOperationId = beginInvitationOperation(invitationContextKey);
    setInvitationError(null);
    setInvitationExpiryError(null);
    setInvitationMessage(null);
    setInvitationNeedsRefresh(true);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-csrf-token': csrfToken,
          Origin: window.location.origin,
          'Idempotency-Key': intent.idempotencyKey,
        },
        body: JSON.stringify({ expiresAt: intent.expiresAt, csrf: csrfToken }),
        cache: 'no-store',
      });
      if (!isCurrentContext()) return;

      if (!response.ok) {
        if (response.status >= 500) {
          setInvitationRetryPendingForContext(invitationContextKey, true);
          setInvitationError(
            'The invitation result could not be confirmed. Retry the same request or reload its status before sharing a link.',
          );
          return;
        }

        invitationCreateIntentsRef.current.delete(invitationContextKey);
        setInvitationRetryPendingForContext(invitationContextKey, false);
        if (response.status === 400 || response.status === 422) {
          setInvitationNeedsRefresh(false);
          setInvitationExpiryError(
            'The selected expiry was not accepted. Choose a future time within 30 days.',
          );
        } else if (response.status === 409) {
          setInvitationNeedsRefresh(true);
          setInvitationError(
            'This invitation request could not be confirmed. Reload invitation status before trying again.',
          );
          setInvitationRefreshVersion((version) => version + 1);
        } else if (response.status === 401 || response.status === 403) {
          setInvitationNeedsRefresh(true);
          setInvitationError(
            'You no longer have permission to manage this candidate invitation.',
          );
        } else {
          setInvitationNeedsRefresh(true);
          setInvitationError(
            'The candidate invitation could not be created. Reload its status before trying again.',
          );
        }
        return;
      }

      const result: R23CandidateInvitationResponse = await response.json();
      if (!isCurrentContext()) return;
      if (result.sessionId !== sessionId) {
        setInvitationRetryPendingForContext(invitationContextKey, true);
        setInvitationError(
          'The invitation result could not be matched to this session. Reload its status before sharing a link.',
        );
        return;
      }

      invitationCreateIntentsRef.current.delete(invitationContextKey);
      setInvitationRetryPendingForContext(invitationContextKey, false);
      setInvitation(result);
      if (
        result.status === 'active' &&
        result.candidatePath &&
        result.expiresAt
      ) {
        setInvitationNeedsRefresh(false);
        setInvitationExpiresAtInput(
          toLocalDateTimeInput(new Date(result.expiresAt)),
        );
        setInvitationMessage(
          `Invitation is active until ${formatInvitationTime(result.expiresAt)}. No email was sent; share the link through an approved channel.`,
        );
      } else if (result.status === 'active') {
        setInvitationNeedsRefresh(true);
        setInvitationError(
          'The invitation is active, but its link or expiry could not be confirmed. Reload status before sharing it.',
        );
      } else {
        setInvitationNeedsRefresh(false);
      }
    } catch {
      if (isCurrentContext()) {
        setInvitationRetryPendingForContext(invitationContextKey, true);
        setInvitationError(
          'The invitation result could not be confirmed. Retry the same request or reload its status before sharing a link.',
        );
      }
    } finally {
      finishInvitationOperation(invitationContextKey, busyOperationId);
    }
  };

  const revokeCandidateInvitation = async () => {
    const sessionId = currentSessionId;
    if (
      !isAuthenticatedStaging ||
      !sessionId ||
      invitation?.status !== 'active' ||
      invitation.sessionId !== sessionId ||
      currentInvitationBusy
    ) {
      return;
    }

    const operationGeneration = invitationContextRef.current.generation;
    const isCurrentContext = () =>
      invitationContextRef.current.generation === operationGeneration;

    const endpoint = `/r23/api/organizations/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(sessionId)}/candidate-token`;
    setInvitationFeedbackContextKey(invitationContextKey);
    const busyOperationId = beginInvitationOperation(invitationContextKey);
    setInvitationNeedsRefresh(true);
    setInvitationError(null);
    setInvitationMessage(null);
    try {
      const response = await fetch(endpoint, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-csrf-token': csrfToken,
          Origin: window.location.origin,
        },
        body: JSON.stringify({ csrf: csrfToken }),
        cache: 'no-store',
      });
      if (!isCurrentContext()) return;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result: R23CandidateInvitationRevocationResponse =
        await response.json();
      if (!isCurrentContext()) return;
      if (result.sessionId !== sessionId || result.status !== 'revoked') {
        throw new Error('Revocation result could not be confirmed.');
      }
      setInvitation({
        sessionId,
        status: 'revoked',
        expiresAt: invitation.expiresAt,
        candidatePath: null,
      });
      setInvitationNeedsRefresh(false);
      setInvitationMessage(
        'Candidate access has been revoked. Saved work remains with the assigned hiring team.',
      );
    } catch {
      if (isCurrentContext()) {
        setInvitationNeedsRefresh(true);
        setInvitationError(
          'Revocation could not be confirmed. Reload invitation status before sharing this link again.',
        );
      }
    } finally {
      finishInvitationOperation(invitationContextKey, busyOperationId);
    }
  };

  const copyCandidateInvitation = async () => {
    const operationGeneration = invitationContextRef.current.generation;
    const candidatePath = confirmedCandidatePathFor(currentSessionId);
    if (!candidatePath || !appOrigin) return;
    setInvitationFeedbackContextKey(invitationContextKey);

    const invitationUrl = absoluteInvitationUrl(candidatePath, appOrigin);
    if (!invitationUrl) return;
    try {
      await navigator.clipboard.writeText(invitationUrl);
      if (invitationContextRef.current.generation === operationGeneration) {
        setInvitationCopyMessage('Candidate invitation link copied.');
      }
    } catch {
      if (invitationContextRef.current.generation === operationGeneration) {
        setInvitationCopyMessage(
          'Copy is unavailable here. Select and copy the invitation link below.',
        );
      }
    }
  };

  // Manage starter files
  const updateStarterFile = (
    index: number,
    field: 'path' | 'content',
    value: string,
  ) => {
    const updated = [...starterFiles];
    updated[index] = { ...updated[index], [field]: value };
    setStarterFiles(updated);
  };

  const addStarterFile = () => {
    setStarterFiles([...starterFiles, { path: 'new_file.py', content: '' }]);
  };

  const removeStarterFile = (index: number) => {
    if (starterFiles.length <= 1) return;
    setStarterFiles(starterFiles.filter((_, idx) => idx !== index));
  };

  // Manage rubric criteria
  const updateRubricCriterion = (
    index: number,
    field: 'label' | 'description' | 'weight',
    value: string | number,
  ) => {
    const updated = [...rubric];
    updated[index] = { ...updated[index], [field]: value };
    setRubric(updated);
  };

  const addRubricCriterion = () => {
    const newId = `criterion-${rubric.length + 1}`;
    setRubric([
      ...rubric,
      {
        id: newId,
        label: `Criterion ${rubric.length + 1}`,
        description: 'Evaluation criteria description',
        weight: 10,
        applicability: {
          kind: 'always',
          rule: 'Applies to all candidate submissions',
        },
      },
    ]);
  };

  const removeRubricCriterion = (index: number) => {
    if (rubric.length <= 1) return;
    setRubric(rubric.filter((_, idx) => idx !== index));
  };

  const updateExpectedBehavior = (index: number, val: string) => {
    const updated = [...expectedBehavior];
    updated[index] = val;
    setExpectedBehavior(updated);
  };

  const addExpectedBehavior = () => {
    setExpectedBehavior([...expectedBehavior, '']);
  };

  const removeExpectedBehavior = (index: number) => {
    if (expectedBehavior.length <= 1) return;
    setExpectedBehavior(expectedBehavior.filter((_, idx) => idx !== index));
  };

  const updateAcceptanceCriterion = (index: number, val: string) => {
    const updated = [...acceptanceCriteria];
    updated[index] = val;
    setAcceptanceCriteria(updated);
  };

  const addAcceptanceCriterion = () => {
    setAcceptanceCriteria([...acceptanceCriteria, '']);
  };

  const removeAcceptanceCriterion = (index: number) => {
    if (acceptanceCriteria.length <= 1) return;
    setAcceptanceCriteria(acceptanceCriteria.filter((_, idx) => idx !== index));
  };

  const activeCandidatePath = confirmedCandidatePathFor(currentSessionId);
  const candidateInvitationUrl =
    activeCandidatePath && appOrigin
      ? absoluteInvitationUrl(activeCandidatePath, appOrigin)
      : null;
  const renderCandidateInvitationControls = (recovered = false) => {
    const currentInvitation =
      invitation?.sessionId === currentSessionId ? invitation : null;
    return (
      <>
        {invitationLoading ? (
          <p role="status">Checking invitation status…</p>
        ) : null}
        {currentInvitationError ? (
          <div
            className="assessment-feedback assessment-feedback-error"
            role="alert"
            data-testid={
              recovered
                ? 'recovered-session-error'
                : 'candidate-invitation-error'
            }
          >
            {currentInvitationError}
          </div>
        ) : null}
        {currentInvitationMessage ? (
          <p role="status">{currentInvitationMessage}</p>
        ) : null}

        {currentInvitation?.status === 'not_created' ? (
          <div>
            <p>
              No candidate invitation has been created. The link defaults to
              seven days and can be set to expire within 30 days. No email will
              be sent.
            </p>
            <label
              htmlFor="candidate-invitation-expires-at"
              style={{ display: 'block', margin: '12px 0' }}
            >
              Invitation expires at
              <input
                id="candidate-invitation-expires-at"
                data-testid="candidate-invitation-expires-at"
                type="datetime-local"
                required
                min={invitationExpiryMin || undefined}
                max={invitationExpiryMax || undefined}
                value={invitationExpiresAtInput}
                aria-invalid={Boolean(invitationExpiryError)}
                aria-describedby={
                  invitationExpiryError
                    ? 'candidate-invitation-expiry-error'
                    : undefined
                }
                disabled={
                  currentInvitationBusy || currentInvitationRetryPending
                }
                onChange={(event) => {
                  setInvitationExpiresAtInput(event.target.value);
                  setInvitationExpiryError(null);
                }}
              />
            </label>
            {invitationExpiryError ? (
              <p id="candidate-invitation-expiry-error" role="alert">
                {invitationExpiryError}
              </p>
            ) : null}
            <button
              type="button"
              className="button button-primary"
              data-testid="candidate-invitation-create"
              disabled={
                currentInvitationBusy ||
                invitationLoading ||
                (currentInvitationNeedsRefresh &&
                  !currentInvitationRetryPending)
              }
              onClick={() => void createCandidateInvitation()}
            >
              {currentInvitationBusy
                ? 'Creating invitation…'
                : currentInvitationRetryPending
                  ? 'Retry invitation creation'
                  : 'Create candidate invitation'}
            </button>
          </div>
        ) : null}

        {currentInvitation?.status === 'active' ? (
          <div>
            {currentInvitationNeedsRefresh ? (
              <p role="status">
                Invitation status is being confirmed. The link stays hidden
                until confirmation.
              </p>
            ) : (
              <p>
                Candidate access is active until{' '}
                <time dateTime={currentInvitation.expiresAt ?? undefined}>
                  {formatInvitationTime(currentInvitation.expiresAt)}
                </time>
                . No email was sent.
              </p>
            )}
            {candidateInvitationUrl ? (
              <>
                <label
                  htmlFor="candidate-invitation-link"
                  style={{ display: 'block', margin: '12px 0' }}
                >
                  Candidate invitation link
                  <input
                    id="candidate-invitation-link"
                    data-testid="candidate-invitation-link"
                    type="text"
                    readOnly
                    value={candidateInvitationUrl}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </label>
                <button
                  type="button"
                  className="button button-secondary"
                  data-testid="candidate-invitation-copy"
                  disabled={currentInvitationBusy}
                  onClick={() => void copyCandidateInvitation()}
                >
                  Copy candidate link
                </button>
                {currentInvitationCopyMessage ? (
                  <p role="status">{currentInvitationCopyMessage}</p>
                ) : null}
              </>
            ) : currentInvitationNeedsRefresh ? null : (
              <p role="alert">
                The active invitation link could not be confirmed. Reload status
                before sharing it.
              </p>
            )}
            <button
              type="button"
              className="button button-secondary"
              data-testid="candidate-invitation-revoke"
              disabled={currentInvitationBusy}
              onClick={() => void revokeCandidateInvitation()}
              style={{ marginLeft: '8px' }}
            >
              {currentInvitationBusy ? 'Updating…' : 'Revoke candidate access'}
            </button>
          </div>
        ) : null}

        {currentInvitation?.status === 'expired' ? (
          <p role="status">
            This invitation expired at{' '}
            {formatInvitationTime(currentInvitation.expiresAt)}. It cannot be
            renewed here; issue a new session to invite a candidate again.
          </p>
        ) : null}
        {currentInvitation?.status === 'revoked' ? (
          <p role="status">
            This invitation has been revoked. Candidate access is blocked and
            saved work is retained. Issue a new session to invite a candidate
            again.
          </p>
        ) : null}
        {currentInvitation?.status === 'unmanaged' ? (
          <p role="status">
            This session has an older invitation that cannot be recovered or
            managed in this demo. Issue a new session before inviting a
            candidate.
          </p>
        ) : null}

        {currentInvitation ||
        currentInvitationError ||
        currentInvitationNeedsRefresh ? (
          <button
            type="button"
            className="button button-secondary"
            data-testid="candidate-invitation-refresh"
            disabled={invitationLoading || currentInvitationBusy}
            onClick={refreshInvitationStatus}
          >
            Reload invitation status
          </button>
        ) : null}
      </>
    );
  };

  return (
    <div className="software-product assessment-builder-page">
      <header className="software-product-header assessment-app-header">
        <a
          className="software-wordmark"
          href={`/r23/organizations/${encodeURIComponent(organizationId)}`}
          aria-label="Hirearchy Software home"
        >
          <span>Hirearchy</span>
          <span className="software-product-capsule">Software</span>
        </a>
        <a
          className="assessment-app-return"
          href={`/r23/organizations/${encodeURIComponent(organizationId)}`}
          data-testid="back-to-organization-link"
        >
          Back to workspace
        </a>
      </header>
      <main className="assessment-builder-shell">
        <div className="assessment-builder-container">
          <header className="assessment-builder-hero">
            <p className="assessment-eyebrow">Assessment authoring</p>
            <h1>Assessment Builder</h1>
            <p>
              Start with meaningful work. Set the expectations. Invite a
              candidate when it is ready.
            </p>
            {isAuthenticatedStaging ? (
              <div
                className="assessment-builder-capability-note"
                data-testid="builder-staging-capabilities-banner"
                role="region"
                aria-label="Authenticated staging capabilities"
              >
                <strong>Local testing</strong>
                <span>
                  {' '}
                  File editing, submissions and human review are available. AI
                  assistance, code execution and external email delivery are
                  off.
                </span>
              </div>
            ) : null}
          </header>

          {/* Stepper Navigation */}
          <nav className="assessment-stage-nav" aria-label="Assessment stages">
            <ol>
              <li>
                <button
                  type="button"
                  aria-current={stage === 'define' ? 'step' : undefined}
                  aria-label="Go to Define stage"
                  className="assessment-stage-button"
                  onClick={navigateToDefine}
                >
                  <span className="assessment-stage-number">01</span>
                  <span className="assessment-stage-label">Define</span>
                  <span className="assessment-stage-caption">
                    {saveStatus === 'saved' ? 'Draft saved' : 'Shape the task'}
                  </span>
                </button>
              </li>
              <li>
                <button
                  type="button"
                  aria-current={stage === 'validate' ? 'step' : undefined}
                  aria-label="Go to Validate stage"
                  className="assessment-stage-button"
                  onClick={() => {
                    setStage('validate');
                    if (!validatedVersion) {
                      void handleValidate();
                    }
                  }}
                >
                  <span className="assessment-stage-number">02</span>
                  <span className="assessment-stage-label">Validate</span>
                  <span className="assessment-stage-caption">
                    {validatedVersion ? 'Validated' : 'Verify structure'}
                  </span>
                </button>
              </li>
              <li>
                <button
                  type="button"
                  aria-current={stage === 'issue' ? 'step' : undefined}
                  aria-label="Go to Issue stage"
                  className="assessment-stage-button"
                  onClick={() => setStage('issue')}
                >
                  <span className="assessment-stage-number">03</span>
                  <span className="assessment-stage-label">Issue</span>
                  <span className="assessment-stage-caption">
                    {issuedSession ? 'Session issued' : 'Issue to candidate'}
                  </span>
                </button>
              </li>
            </ol>
          </nav>

          {/* Stepper Content Panels */}
          <section
            className="assessment-stage-panel"
            aria-labelledby="assessment-stage-title"
            data-stage={stage}
          >
            <header className="assessment-stage-heading">
              <span className="assessment-stage-index">
                {stage === 'define' ? '01' : stage === 'validate' ? '02' : '03'}{' '}
                <span aria-hidden="true">/ 03</span>
              </span>
              <div>
                <h2 id="assessment-stage-title">
                  {stage === 'define'
                    ? 'Define Assessment'
                    : stage === 'validate'
                      ? 'Validate Structure & Integrity'
                      : 'Issue Assessment'}
                </h2>
                <p>
                  {stage === 'define'
                    ? 'Choose a starting point and prepare the candidate experience.'
                    : stage === 'validate'
                      ? 'Check the structure and review the exact version candidates will receive.'
                      : 'Issue validated assessment version and receive unique candidate workspace link.'}
                </p>
              </div>
            </header>

            {/* STAGE 1: DEFINE */}
            {stage === 'define' && (
              <div
                className="assessment-stage-content"
                suppressHydrationWarning
                style={{
                  padding: 'clamp(12px, 2.5vw, 24px)',
                  boxSizing: 'border-box',
                  minWidth: 0,
                  maxWidth: '100%',
                  overflowWrap: 'anywhere',
                }}
              >
                {/* Save Feedback Alerts */}
                {saveStatus === 'saved' && (
                  <div
                    className="assessment-feedback"
                    role="status"
                    data-testid="draft-status"
                    style={{
                      borderColor: 'var(--software-mint-border, #10b981)',
                      background: 'var(--software-mint, #ecfdf5)',
                      color: 'var(--software-ink, #064e3b)',
                      marginBottom: '16px',
                    }}
                  >
                    <span>
                      {DRAFT_SAVED_MESSAGE} (Version {draftVersion})
                    </span>
                  </div>
                )}
                {saveStatus === 'conflict' && (
                  <div
                    className="assessment-feedback assessment-feedback-error"
                    role="alert"
                    data-testid="draft-status"
                    style={{ marginBottom: '16px' }}
                  >
                    <span>{saveErrorMessage}</span>
                  </div>
                )}
                {saveStatus === 'error' && (
                  <div
                    className="assessment-feedback assessment-feedback-error"
                    role="alert"
                    data-testid="draft-status"
                    style={{ marginBottom: '16px' }}
                  >
                    <span>{saveErrorMessage}</span>
                  </div>
                )}

                <div className="assessment-template-choice">
                  <label htmlFor="assessment-template">
                    Assessment template
                  </label>
                  <select
                    id="assessment-template"
                    value={templateId}
                    disabled={Boolean(issuedSession)}
                    onChange={(event) => {
                      if (recoveredSessionId || recoveryContextError) {
                        clearRecoveredSessionContext();
                      }
                      setTemplateId(
                        event.target.value as 'custom' | 'reservation-moves-v3',
                      );
                      setValidatedVersion(null);
                    }}
                  >
                    <option value="reservation-moves-v3">
                      Reservation Moves v3
                    </option>
                    <option value="custom">Create a custom assessment</option>
                  </select>
                </div>
                {templateId === 'reservation-moves-v3' ? (
                  <div className="assessment-template-preview">
                    <div className="assessment-template-heading">
                      <span className="assessment-template-tag">
                        Approved template
                      </span>
                      <span>Python · State &amp; retries</span>
                    </div>
                    <h3>Reservation Moves</h3>
                    <p>
                      A failed request should not lose a booking. An old retry
                      should not undo a newer move. Candidates repair a small
                      Python service while preserving its public contract.
                    </p>
                    <div className="assessment-template-details">
                      <span>Real source files</span>
                      <span>Clear acceptance criteria</span>
                      <span>Human evidence review</span>
                    </div>
                    <p className="assessment-template-footnote">
                      The brief, workspace and review criteria come from the
                      approved template. Set the session duration below.
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Title */}
                    <div style={{ marginBottom: '20px' }}>
                      <label
                        htmlFor="assessment-title"
                        style={{
                          display: 'block',
                          fontWeight: 600,
                          marginBottom: '6px',
                        }}
                      >
                        Assessment Title
                      </label>
                      <input
                        id="assessment-title"
                        name="title"
                        type="text"
                        suppressHydrationWarning
                        data-testid="assessment-title-input"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        className="assessment-input-control"
                      />
                      {getFieldIssue('title') && (
                        <p
                          style={{
                            color: 'var(--software-status-danger, #dc2626)',
                            fontSize: '0.8rem',
                            marginTop: '4px',
                          }}
                        >
                          {getFieldIssue('title')}
                        </p>
                      )}
                    </div>

                    {/* Candidate Brief */}
                    <div style={{ marginBottom: '20px' }}>
                      <label
                        htmlFor="assessment-brief"
                        style={{
                          display: 'block',
                          fontWeight: 600,
                          marginBottom: '6px',
                        }}
                      >
                        Candidate instructions / brief
                      </label>
                      <textarea
                        id="assessment-brief"
                        name="brief"
                        rows={5}
                        suppressHydrationWarning
                        data-testid="assessment-brief-input"
                        value={brief}
                        onChange={(e) => setBrief(e.target.value)}
                        className="assessment-input-control"
                      />
                      {getFieldIssue('brief') && (
                        <p
                          style={{
                            color: 'var(--software-status-danger, #dc2626)',
                            fontSize: '0.8rem',
                            marginTop: '4px',
                          }}
                        >
                          {getFieldIssue('brief')}
                        </p>
                      )}
                    </div>

                    {/* Expected Behavior */}
                    <div style={{ marginBottom: '20px' }}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: '8px',
                        }}
                      >
                        <label style={{ fontWeight: 600 }}>
                          Expected Behavior Verification Targets
                        </label>
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={addExpectedBehavior}
                          style={{ padding: '4px 10px', fontSize: '0.8rem' }}
                        >
                          + Add target
                        </button>
                      </div>
                      {expectedBehavior.map((item, idx) => (
                        <div
                          key={idx}
                          style={{
                            display: 'flex',
                            gap: '8px',
                            marginBottom: '8px',
                          }}
                        >
                          <input
                            type="text"
                            aria-label={`Expected behavior ${idx + 1}`}
                            value={item}
                            onChange={(e) =>
                              updateExpectedBehavior(idx, e.target.value)
                            }
                            className="assessment-input-row-item"
                          />
                          <button
                            type="button"
                            disabled={expectedBehavior.length <= 1}
                            onClick={() => removeExpectedBehavior(idx)}
                            style={{
                              padding: '4px 8px',
                              borderRadius: '4px',
                              border: '1px solid var(--software-border, #ccc)',
                              background: '#fff',
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                      {getFieldIssue('expectedBehavior') && (
                        <p
                          style={{
                            color: 'var(--software-status-danger, #dc2626)',
                            fontSize: '0.8rem',
                            marginTop: '4px',
                          }}
                        >
                          {getFieldIssue('expectedBehavior')}
                        </p>
                      )}
                    </div>

                    {/* Acceptance Criteria */}
                    <div style={{ marginBottom: '20px' }}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: '8px',
                        }}
                      >
                        <label style={{ fontWeight: 600 }}>
                          Acceptance Criteria
                        </label>
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={addAcceptanceCriterion}
                          style={{ padding: '4px 10px', fontSize: '0.8rem' }}
                        >
                          + Add criterion
                        </button>
                      </div>
                      {acceptanceCriteria.map((item, idx) => (
                        <div
                          key={idx}
                          style={{
                            display: 'flex',
                            gap: '8px',
                            marginBottom: '8px',
                          }}
                        >
                          <input
                            type="text"
                            aria-label={`Acceptance criterion ${idx + 1}`}
                            value={item}
                            onChange={(e) =>
                              updateAcceptanceCriterion(idx, e.target.value)
                            }
                            className="assessment-input-row-item"
                          />
                          <button
                            type="button"
                            disabled={acceptanceCriteria.length <= 1}
                            onClick={() => removeAcceptanceCriterion(idx)}
                            style={{
                              padding: '4px 8px',
                              borderRadius: '4px',
                              border: '1px solid var(--software-border, #ccc)',
                              background: '#fff',
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                      {getFieldIssue('acceptanceCriteria') && (
                        <p
                          style={{
                            color: 'var(--software-status-danger, #dc2626)',
                            fontSize: '0.8rem',
                            marginTop: '4px',
                          }}
                        >
                          {getFieldIssue('acceptanceCriteria')}
                        </p>
                      )}
                    </div>

                    {/* Primary File Path */}
                    <div style={{ marginBottom: '20px' }}>
                      <label
                        htmlFor="primary-file-path"
                        style={{
                          display: 'block',
                          fontWeight: 600,
                          marginBottom: '6px',
                        }}
                      >
                        Primary file path (.py)
                      </label>
                      <input
                        id="primary-file-path"
                        name="primaryFilePath"
                        type="text"
                        suppressHydrationWarning
                        data-testid="primary-file-path-input"
                        value={primaryFilePath}
                        onChange={(e) => setPrimaryFilePath(e.target.value)}
                        className="assessment-input-control"
                      />
                      {getFieldIssue('primaryFilePath') && (
                        <p
                          style={{
                            color: 'var(--software-status-danger, #dc2626)',
                            fontSize: '0.8rem',
                            marginTop: '4px',
                          }}
                        >
                          {getFieldIssue('primaryFilePath')}
                        </p>
                      )}
                    </div>

                    {/* Starter Workspace Files */}
                    <div style={{ marginBottom: '24px' }}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: '10px',
                        }}
                      >
                        <label style={{ fontWeight: 600 }}>
                          Starter Workspace Files
                        </label>
                        <button
                          type="button"
                          data-testid="add-file-button"
                          className="button button-secondary"
                          onClick={addStarterFile}
                          style={{ padding: '4px 10px', fontSize: '0.8rem' }}
                        >
                          + Add file
                        </button>
                      </div>
                      {starterFiles.map((file, idx) => (
                        <div
                          key={idx}
                          style={{
                            padding: '12px',
                            border: '1px solid var(--software-border, #e5e7eb)',
                            borderRadius: 'var(--software-radius-control, 6px)',
                            marginBottom: '12px',
                            background: 'var(--software-canvas, #f9fafb)',
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              gap: '8px',
                              marginBottom: '8px',
                            }}
                          >
                            <input
                              type="text"
                              aria-label={`Starter file ${idx + 1} path`}
                              placeholder="file path (e.g. app.py)"
                              data-testid={`file-path-input-${idx}`}
                              value={file.path}
                              onChange={(e) =>
                                updateStarterFile(idx, 'path', e.target.value)
                              }
                              className="assessment-input-row-item-compact"
                            />
                            <button
                              type="button"
                              data-testid={`remove-file-button-${idx}`}
                              disabled={starterFiles.length <= 1}
                              onClick={() => removeStarterFile(idx)}
                              style={{
                                padding: '4px 8px',
                                borderRadius: '4px',
                                border:
                                  '1px solid var(--software-border, #ccc)',
                                background: '#fff',
                                cursor:
                                  starterFiles.length <= 1
                                    ? 'not-allowed'
                                    : 'pointer',
                              }}
                            >
                              Remove
                            </button>
                          </div>
                          <textarea
                            rows={4}
                            aria-label={`Starter file ${idx + 1} content`}
                            placeholder="file content..."
                            data-testid={`file-content-input-${idx}`}
                            value={file.content}
                            onChange={(e) =>
                              updateStarterFile(idx, 'content', e.target.value)
                            }
                            style={{
                              width: '100%',
                              fontFamily: 'monospace',
                              fontSize: '0.85rem',
                              padding: '8px',
                              borderRadius: '4px',
                              border: '1px solid var(--software-border, #ccc)',
                            }}
                          />
                        </div>
                      ))}
                      {getFieldIssue('starterFiles') && (
                        <p
                          style={{
                            color: 'var(--software-status-danger, #dc2626)',
                            fontSize: '0.8rem',
                            marginTop: '4px',
                          }}
                        >
                          {getFieldIssue('starterFiles')}
                        </p>
                      )}
                    </div>
                  </>
                )}
                {/* Duration and Capabilities */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns:
                      'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
                    gap: '20px',
                    marginBottom: '24px',
                    minWidth: 0,
                    maxWidth: '100%',
                  }}
                >
                  <div>
                    <label
                      htmlFor="duration-minutes"
                      style={{
                        display: 'block',
                        fontWeight: 600,
                        marginBottom: '6px',
                      }}
                    >
                      Duration
                    </label>
                    <select
                      id="duration-minutes"
                      name="durationMinutes"
                      suppressHydrationWarning
                      value={durationMinutes}
                      onChange={(e) =>
                        setDurationMinutes(Number(e.target.value))
                      }
                      className="assessment-input-control"
                    >
                      <option value={30}>30 minutes</option>
                      <option value={45}>45 minutes</option>
                      <option value={60}>60 minutes</option>
                      <option value={90}>90 minutes</option>
                    </select>
                  </div>

                  <div>
                    <span
                      style={{
                        display: 'block',
                        fontWeight: 600,
                        marginBottom: '6px',
                      }}
                    >
                      Capabilities
                    </span>
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        marginBottom: '8px',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        id="terminal-enabled"
                        name="terminalEnabled"
                        checked={terminalEnabled}
                        disabled={isAuthenticatedStaging}
                        onChange={(e) => setTerminalEnabled(e.target.checked)}
                      />
                      <span>
                        {isAuthenticatedStaging
                          ? 'Verification recipe required by the template'
                          : 'Terminal verification enabled (required)'}
                      </span>
                    </label>
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        id="integrated-ai"
                        name="integratedAi"
                        checked={integratedAi}
                        disabled={isAuthenticatedStaging}
                        onChange={(e) => setIntegratedAi(e.target.checked)}
                      />
                      <span>
                        {isAuthenticatedStaging
                          ? 'AI assistance is unavailable in local testing'
                          : 'Integrated AI enabled (synthetic test lane)'}
                      </span>
                    </label>
                    {getFieldIssue('terminalEnabled') && (
                      <p
                        style={{
                          color: 'var(--software-status-danger, #dc2626)',
                          fontSize: '0.8rem',
                          marginTop: '4px',
                        }}
                      >
                        {getFieldIssue('terminalEnabled')}
                      </p>
                    )}
                    {getFieldIssue('integratedAi') && (
                      <p
                        style={{
                          color: 'var(--software-status-danger, #dc2626)',
                          fontSize: '0.8rem',
                          marginTop: '4px',
                        }}
                      >
                        {getFieldIssue('integratedAi')}
                      </p>
                    )}
                  </div>
                </div>

                {templateId === 'custom' && (
                  /* Rubric Criteria */
                  <div style={{ marginBottom: '28px' }}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '10px',
                      }}
                    >
                      <div>
                        <span style={{ fontWeight: 600, display: 'block' }}>
                          Rubric Criteria & Weights
                        </span>
                        <span
                          data-testid="rubric-total-weight"
                          style={{
                            fontSize: '0.82rem',
                            color:
                              rubricTotalWeight === 100
                                ? 'var(--software-muted)'
                                : 'var(--software-status-danger, #dc2626)',
                            fontWeight: rubricTotalWeight === 100 ? 500 : 700,
                          }}
                        >
                          Total Weight: {rubricTotalWeight}% (must equal 100%)
                        </span>
                      </div>
                      <button
                        type="button"
                        data-testid="add-rubric-button"
                        className="button button-secondary"
                        onClick={addRubricCriterion}
                        style={{ padding: '4px 10px', fontSize: '0.8rem' }}
                      >
                        + Add criterion
                      </button>
                    </div>
                    {rubric.map((crit, idx) => (
                      <div
                        key={crit.id}
                        style={{
                          padding: '12px',
                          border: '1px solid var(--software-border, #e5e7eb)',
                          borderRadius: 'var(--software-radius-control, 6px)',
                          marginBottom: '10px',
                          background: 'var(--software-surface, #fff)',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            gap: '8px',
                            marginBottom: '8px',
                          }}
                        >
                          <input
                            type="text"
                            aria-label={`Criterion ${idx + 1} label`}
                            placeholder="Criterion label"
                            value={crit.label}
                            onChange={(e) =>
                              updateRubricCriterion(
                                idx,
                                'label',
                                e.target.value,
                              )
                            }
                            className="assessment-input-row-item-compact"
                            style={{ flex: 2 }}
                          />
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                            }}
                          >
                            <input
                              type="number"
                              aria-label={`Criterion ${idx + 1} weight`}
                              value={crit.weight}
                              onChange={(e) =>
                                updateRubricCriterion(
                                  idx,
                                  'weight',
                                  Number(e.target.value),
                                )
                              }
                              className="assessment-input-row-item-compact"
                              style={{ width: '70px', flex: 'none' }}
                            />
                            <span style={{ fontSize: '0.85rem' }}>%</span>
                          </div>
                          <button
                            type="button"
                            disabled={rubric.length <= 1}
                            onClick={() => removeRubricCriterion(idx)}
                            style={{
                              padding: '4px 8px',
                              borderRadius: '4px',
                              border: '1px solid var(--software-border, #ccc)',
                              background: '#fff',
                              cursor:
                                rubric.length <= 1 ? 'not-allowed' : 'pointer',
                            }}
                          >
                            Remove
                          </button>
                        </div>
                        <input
                          type="text"
                          aria-label={`Criterion ${idx + 1} description`}
                          placeholder="Criterion description"
                          value={crit.description}
                          onChange={(e) =>
                            updateRubricCriterion(
                              idx,
                              'description',
                              e.target.value,
                            )
                          }
                          className="assessment-input-row-item-compact"
                          style={{ width: '100%' }}
                        />
                      </div>
                    ))}
                    {getFieldIssue('rubric') && (
                      <p
                        style={{
                          color: 'var(--software-status-danger, #dc2626)',
                          fontSize: '0.8rem',
                          marginTop: '4px',
                        }}
                      >
                        {getFieldIssue('rubric')}
                      </p>
                    )}
                  </div>
                )}

                {/* Actions */}
                <div
                  className="assessment-authoring-actions"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    paddingTop: '16px',
                    borderTop: '1px solid var(--software-border, #e5e7eb)',
                  }}
                >
                  <button
                    type="button"
                    data-testid="save-draft-button"
                    className="button button-secondary"
                    disabled={isSaving}
                    onClick={handleSaveDraft}
                  >
                    {isSaving ? 'Saving...' : 'Save draft'}
                  </button>

                  <button
                    type="button"
                    data-testid="continue-to-validate-button"
                    className="button button-primary"
                    disabled={isSaving || isValidating}
                    onClick={() => {
                      setStage('validate');
                      void handleValidate();
                    }}
                  >
                    Continue to Validate →
                  </button>
                </div>
              </div>
            )}

            {/* STAGE 2: VALIDATE */}
            {stage === 'validate' && (
              <div
                className="assessment-stage-content"
                style={{
                  padding: 'clamp(12px, 2.5vw, 24px)',
                  boxSizing: 'border-box',
                  minWidth: 0,
                  maxWidth: '100%',
                  overflowWrap: 'anywhere',
                }}
              >
                {isValidating && (
                  <div
                    className="assessment-preparation-status"
                    style={{ marginBottom: '16px' }}
                  >
                    <span className="assessment-status-mark">⌛</span>
                    <div>
                      <strong>Validating Assessment Definition</strong>
                      <p>
                        Running structural checks, file path verification, and
                        rubric integrity audits...
                      </p>
                    </div>
                  </div>
                )}

                {/* Validation Error Banner */}
                {validationErrorMessage && (
                  <div
                    className="assessment-feedback assessment-feedback-error"
                    role="alert"
                    data-testid="validation-error-banner"
                    style={{ marginBottom: '20px' }}
                  >
                    <div>
                      <strong style={{ display: 'block', marginBottom: '4px' }}>
                        Validation Failed
                      </strong>
                      <span>{validationErrorMessage}</span>
                      {validationIssues.length > 0 && (
                        <ul style={{ margin: '8px 0 0', paddingLeft: '20px' }}>
                          {validationIssues.map((issue, idx) => (
                            <li key={idx}>
                              <code>{issue.field}</code>: {issue.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={navigateToDefine}
                      style={{ flexShrink: 0, marginLeft: '12px' }}
                    >
                      Fix in Define
                    </button>
                  </div>
                )}

                {/* Validation Success */}
                {validatedVersion && !validationErrorMessage && (
                  <div style={{ marginBottom: '24px' }}>
                    <div
                      data-testid="validated-version-display"
                      style={{
                        padding: '16px',
                        borderRadius: 'var(--software-radius-control, 6px)',
                        border: '1px solid var(--software-border, #10b981)',
                        background: 'var(--software-mint, #ecfdf5)',
                        marginBottom: '16px',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          marginBottom: '8px',
                        }}
                      >
                        <span
                          style={{
                            fontWeight: 700,
                            fontSize: '1.1rem',
                            color: '#064e3b',
                          }}
                        >
                          Version {validatedVersion.versionNumber} Validated
                        </span>
                        <span
                          data-testid="content-digest-badge"
                          style={{
                            fontFamily: 'monospace',
                            fontSize: '0.85rem',
                            padding: '4px 8px',
                            borderRadius: '999px',
                            background: '#047857',
                            color: '#fff',
                            fontWeight: 600,
                          }}
                        >
                          {formatDigestBadge(validatedVersion.contentDigest)}
                        </span>
                      </div>
                      <p
                        style={{
                          margin: '0 0 8px',
                          color: '#065f46',
                          fontSize: '0.9rem',
                        }}
                      >
                        Title: <strong>{validatedVersion.scenarioTitle}</strong>
                      </p>
                      <p
                        data-testid="execution-notice"
                        style={{
                          margin: 0,
                          fontSize: '0.82rem',
                          color: '#047857',
                          fontStyle: 'italic',
                        }}
                      >
                        {EXECUTION_VALIDATION_NOTICE}
                      </p>
                    </div>

                    <div
                      style={{
                        padding: '16px',
                        border: '1px solid var(--software-border, #e5e7eb)',
                        borderRadius: '6px',
                        background: 'var(--software-surface, #fff)',
                      }}
                    >
                      <h4 style={{ margin: '0 0 10px', fontSize: '0.95rem' }}>
                        Snapshot Summary
                      </h4>
                      <dl
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '140px 1fr',
                          gap: '6px',
                          fontSize: '0.85rem',
                          margin: 0,
                        }}
                      >
                        <dt style={{ color: 'var(--software-muted)' }}>
                          Full Digest
                        </dt>
                        <dd
                          style={{
                            fontFamily: 'monospace',
                            wordBreak: 'break-all',
                          }}
                        >
                          {formatFullDigest(validatedVersion.contentDigest)}
                        </dd>
                        <dt style={{ color: 'var(--software-muted)' }}>
                          Scenario ID
                        </dt>
                        <dd>
                          <code>{validatedVersion.scenarioId}</code>
                        </dd>
                        <dt style={{ color: 'var(--software-muted)' }}>
                          Duration
                        </dt>
                        <dd>
                          {Math.round(validatedVersion.durationSeconds / 60)}{' '}
                          minutes
                        </dd>
                        <dt style={{ color: 'var(--software-muted)' }}>
                          Workspace Files
                        </dt>
                        <dd>
                          {
                            Object.keys(
                              validatedVersion.scenarioSnapshot
                                ?.workspaceFiles ?? {},
                            ).length
                          }{' '}
                          files included
                        </dd>
                      </dl>
                    </div>
                  </div>
                )}

                {/* Validate Stage Actions */}
                <div
                  className="assessment-authoring-actions"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    paddingTop: '16px',
                    borderTop: '1px solid var(--software-border, #e5e7eb)',
                  }}
                >
                  <button
                    type="button"
                    className="button button-secondary"
                    aria-label="Back to Define"
                    onClick={navigateToDefine}
                  >
                    Back
                  </button>

                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button
                      type="button"
                      data-testid="validate-assessment-button"
                      className="button button-secondary"
                      aria-label="Re-run Validation"
                      disabled={isValidating}
                      onClick={handleValidate}
                    >
                      {isValidating ? 'Checking...' : 'Recheck'}
                    </button>

                    <button
                      type="button"
                      data-testid="continue-to-issue-button"
                      aria-label="Continue to Issue"
                      className="button button-primary"
                      disabled={
                        !validatedVersion || Boolean(validationErrorMessage)
                      }
                      onClick={() => setStage('issue')}
                    >
                      Continue
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* STAGE 3: ISSUE */}
            {stage === 'issue' && (
              <div
                className="assessment-stage-content"
                style={{
                  padding: 'clamp(12px, 2.5vw, 24px)',
                  boxSizing: 'border-box',
                  minWidth: 0,
                  maxWidth: '100%',
                  overflowWrap: 'anywhere',
                }}
              >
                {(recoveredSessionId || recoveryContextError) &&
                !issuedSession ? (
                  <section
                    className="assessment-feedback"
                    data-testid="recovered-candidate-invitation-panel"
                    aria-label="Recovered candidate invitation"
                    style={{ marginBottom: '20px' }}
                  >
                    <h3>Recovered candidate invitation</h3>
                    <p>
                      This reference is checked against your authorized
                      organization session. Refreshing this page does not issue
                      another session.
                    </p>
                    {recoveryContextError ? (
                      <div
                        role="alert"
                        data-testid="recovered-session-error"
                        className="assessment-feedback assessment-feedback-error"
                      >
                        {recoveryContextError}
                      </div>
                    ) : null}
                    {recoveredSessionId &&
                    invitation?.sessionId === recoveredSessionId ? (
                      <p>
                        Session reference:{' '}
                        <code data-testid="recovered-session-id">
                          {invitation.sessionId}
                        </code>
                      </p>
                    ) : null}
                    {renderCandidateInvitationControls(true)}
                    <button
                      type="button"
                      className="button button-secondary"
                      data-testid="return-to-assessment-draft"
                      onClick={navigateToDefine}
                      style={{ marginLeft: '8px' }}
                    >
                      Return to assessment draft
                    </button>
                  </section>
                ) : null}

                {!validatedVersion &&
                  !recoveredSessionId &&
                  !recoveryContextError && (
                    <div
                      className="assessment-feedback assessment-feedback-warning"
                      style={{ marginBottom: '20px' }}
                    >
                      <span>
                        You must validate an assessment version before issuing
                        sessions.
                      </span>
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => setStage('validate')}
                      >
                        Go to Validate
                      </button>
                    </div>
                  )}

                {validatedVersion &&
                  !issuedSession &&
                  !recoveredSessionId &&
                  !recoveryContextError && (
                    <div>
                      <div
                        style={{
                          padding: '16px',
                          border: '1px solid var(--software-border, #e5e7eb)',
                          borderRadius: '6px',
                          marginBottom: '20px',
                          background: 'var(--software-surface, #fff)',
                        }}
                      >
                        <h3 style={{ margin: '0 0 12px', fontSize: '1.1rem' }}>
                          Ready to Issue Assessment
                        </h3>
                        <p
                          style={{
                            margin: '0 0 12px',
                            fontSize: '0.88rem',
                            color: 'var(--software-muted)',
                          }}
                        >
                          You are about to issue a candidate session backed by
                          immutable validated version{' '}
                          {validatedVersion.versionNumber}.
                        </p>
                        <dl
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '160px 1fr',
                            gap: '6px',
                            fontSize: '0.85rem',
                            margin: 0,
                          }}
                        >
                          <dt style={{ color: 'var(--software-muted)' }}>
                            Assessment Title
                          </dt>
                          <dd>
                            <strong>{validatedVersion.scenarioTitle}</strong>
                          </dd>
                          <dt style={{ color: 'var(--software-muted)' }}>
                            Validated Version
                          </dt>
                          <dd>Version {validatedVersion.versionNumber}</dd>
                          <dt style={{ color: 'var(--software-muted)' }}>
                            Content Digest
                          </dt>
                          <dd style={{ fontFamily: 'monospace' }}>
                            {formatDigestBadge(validatedVersion.contentDigest)}
                          </dd>
                          <dt style={{ color: 'var(--software-muted)' }}>
                            Time Limit
                          </dt>
                          <dd>
                            {Math.round(validatedVersion.durationSeconds / 60)}{' '}
                            minutes
                          </dd>
                          <dt style={{ color: 'var(--software-muted)' }}>
                            Idempotency Key
                          </dt>
                          <dd suppressHydrationWarning>
                            <code suppressHydrationWarning>
                              {idempotencyKey}
                            </code>
                          </dd>
                        </dl>

                        {(isAuthenticatedStaging || reviewers.length > 0) && (
                          <div
                            style={{
                              marginTop: '16px',
                              paddingTop: '16px',
                              borderTop:
                                '1px solid var(--software-border, #e5e7eb)',
                            }}
                          >
                            <label
                              htmlFor="issue-reviewer-select"
                              style={{
                                display: 'block',
                                fontWeight: 600,
                                marginBottom: '6px',
                                fontSize: '0.9rem',
                              }}
                            >
                              Assign Authorized Evaluator (Reviewer)
                            </label>
                            <select
                              id="issue-reviewer-select"
                              name="reviewerPrincipalId"
                              data-testid="issue-reviewer-select"
                              suppressHydrationWarning
                              value={effectiveReviewerPrincipalId}
                              onChange={(e) =>
                                setSelectedReviewerPrincipalId(e.target.value)
                              }
                              className="assessment-input-control"
                            >
                              <option value="">
                                Select an eligible organization reviewer
                              </option>
                              <AssessmentReviewerOptions
                                reviewers={reviewers}
                              />
                            </select>
                          </div>
                        )}
                      </div>

                      {issuanceError && (
                        <div
                          className="assessment-feedback assessment-feedback-error"
                          role="alert"
                          style={{ marginBottom: '16px' }}
                        >
                          <span>{issuanceError}</span>
                        </div>
                      )}

                      <div
                        className="assessment-authoring-actions"
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          paddingTop: '16px',
                          borderTop:
                            '1px solid var(--software-border, #e5e7eb)',
                        }}
                      >
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => setStage('validate')}
                        >
                          ← Back to Validate
                        </button>

                        <button
                          type="button"
                          data-testid="issue-assessment-button"
                          className="button button-primary"
                          disabled={isIssuing}
                          onClick={handleIssue}
                        >
                          {isIssuing
                            ? 'Issuing session...'
                            : 'Issue assessment'}
                        </button>
                      </div>
                    </div>
                  )}

                {/* Issued Session Success State */}
                {issuedSession && (
                  <div
                    data-testid="issuance-success"
                    style={{
                      padding: '24px',
                      borderRadius: 'var(--software-radius-surface, 8px)',
                      border: '1px solid #10b981',
                      background: '#ecfdf5',
                    }}
                  >
                    <h3
                      style={{
                        margin: '0 0 12px',
                        color: '#064e3b',
                        fontSize: '1.25rem',
                      }}
                    >
                      Assessment Successfully Issued!
                    </h3>
                    <p
                      style={{
                        margin: '0 0 16px',
                        color: '#065f46',
                        fontSize: '0.9rem',
                      }}
                    >
                      The candidate session has been created and bound to
                      immutable validated version{' '}
                      {validatedVersion?.versionNumber}.
                    </p>

                    <div
                      style={{
                        background: '#fff',
                        padding: '16px',
                        borderRadius: '6px',
                        border: '1px solid #a7f3d0',
                        marginBottom: '20px',
                      }}
                    >
                      <dl
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '140px 1fr',
                          gap: '8px',
                          fontSize: '0.9rem',
                          margin: 0,
                        }}
                      >
                        <dt style={{ fontWeight: 600 }}>Session Reference:</dt>
                        <dd>
                          <code data-testid="issued-session-id">
                            {issuedSession.sessionId}
                          </code>
                        </dd>
                        {issuedSession.reviewerPrincipalId ? (
                          <>
                            <dt style={{ fontWeight: 600 }}>
                              Assigned Evaluator:
                            </dt>
                            <dd>
                              <code data-testid="issued-reviewer-principal-id">
                                {issuedSession.reviewerPrincipalId}
                              </code>
                            </dd>
                          </>
                        ) : null}
                        <dt style={{ fontWeight: 600 }}>Candidate Link:</dt>
                        <dd>
                          <section
                            className="assessment-feedback"
                            data-testid="candidate-invitation-panel"
                            aria-label="Candidate invitation"
                          >
                            <h4>Candidate invitation</h4>
                            {renderCandidateInvitationControls()}
                            {issuedSession.candidatePath &&
                            !candidateInvitationUrl ? (
                              <div style={{ marginTop: '8px' }}>
                                <Link
                                  href={issuedSession.candidatePath}
                                  data-testid="candidate-workspace-link"
                                  style={{
                                    color: '#047857',
                                    fontWeight: 600,
                                    wordBreak: 'break-all',
                                  }}
                                >
                                  {issuedSession.candidatePath}
                                </Link>
                              </div>
                            ) : null}
                          </section>
                        </dd>
                      </dl>
                    </div>

                    <div style={{ display: 'flex', gap: '12px' }}>
                      <Link
                        href={`/r23/organizations/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(issuedSession.sessionId)}`}
                        className="button button-secondary"
                        data-testid="inspect-session-link"
                      >
                        Inspect Session in Organization
                      </Link>
                      <Link
                        href={`/r23/organizations/${encodeURIComponent(organizationId)}`}
                        className="button button-secondary"
                      >
                        Back to Session List
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
