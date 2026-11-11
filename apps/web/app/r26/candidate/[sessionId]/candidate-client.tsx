'use client';

import { SoftwareMark } from '../../../../src/ui/software-mark';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import {
  IconCode,
  IconFileDescription,
  IconTimeline,
} from '@tabler/icons-react';

import type {
  R26CandidateEvent,
  R26CandidateFileView,
} from '../../../../../../database/postgres/r26/adapter.mjs';
import type {
  R26CandidateActivationInput,
  R26CandidateGetResponse,
} from '../../../../src/r26-candidate/contract';
import type { R212CandidateAiView } from '../../../../src/r212-ai/contract';
import type {
  R213CandidateExecutionView,
  R213RecordedOperation,
} from '../../../../src/r213-execution/contract';
import { ScenarioBrief } from '../../../../src/ui/scenario-brief';
import './candidate-workspace.css';

type CandidateClientProps = Readonly<{ sessionId: string }>;

type ApiFailure = Error & Readonly<{ status?: number; code?: string }>;

type Draft = Readonly<{
  path: string;
  content: string;
  baseContent: string;
  baseVersion: string;
  baseDigest: string;
}>;

type PendingSave = Readonly<{
  requestId: string;
  path: string;
  content: string;
  expectedVersion: string;
}>;

type PendingSubmit = Readonly<{
  requestId: string;
  expectedWorkspaceDigest: string;
}>;

const tokenPattern = /^(?:[A-Za-z0-9_-]{32}|[A-Za-z0-9_-]{43})$/;
const tokenStoragePrefix = 'hirearchy:r26:candidate-token:v1:';

function isValidToken(value: string | null): value is string {
  if (!value || !tokenPattern.test(value)) return false;
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const canonical = btoa(binary)
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
    return canonical === value && [24, 32].includes(binary.length);
  } catch {
    return false;
  }
}

function errorFromResponse(status: number, value: unknown): ApiFailure {
  const errorValue =
    typeof value === 'object' && value !== null && 'error' in value
      ? (value as { error?: { code?: unknown } }).error
      : undefined;
  const code =
    typeof errorValue?.code === 'string'
      ? errorValue.code
      : 'WORKSPACE_UNAVAILABLE';
  const message =
    code === 'ASSESSMENT_CONFLICT'
      ? 'The saved assessment state changed. Review the latest saved version and try again.'
      : code === 'CANDIDATE_ACCESS_DENIED'
        ? 'This candidate link is not available for this assessment.'
        : code === 'ORIGIN_DENIED'
          ? 'Reload the candidate workspace before trying again.'
          : code === 'REQUEST_TOO_LARGE'
            ? 'This file is larger than the supported limit.'
            : code === 'INVALID_REQUEST'
              ? 'The workspace could not accept that request.'
              : 'The isolated candidate workspace is temporarily unavailable.';
  return Object.assign(new Error(message), { status, code });
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours > 0) return `${hours} hr ${minutes} min remaining`;
  if (minutes > 0) return `${minutes} min ${remainingSeconds} sec remaining`;
  return `${remainingSeconds} sec remaining`;
}

function timestampMilliseconds(
  value: string | null | undefined,
): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function earliestTimestamp(values: readonly (number | null)[]): number | null {
  const timestamps = values.filter((value): value is number => value !== null);
  return timestamps.length > 0 ? Math.min(...timestamps) : null;
}

function formatDateTime(timestamp: number | null): string {
  return timestamp === null
    ? 'time unavailable'
    : new Date(timestamp).toLocaleString();
}

function isCandidateAccessUnavailable(error: unknown): boolean {
  const failure = error as ApiFailure;
  return (
    failure.status === 401 ||
    failure.status === 404 ||
    failure.code === 'CANDIDATE_ACCESS_DENIED'
  );
}

function scenarioText(
  scenario: Readonly<Record<string, unknown>>,
  key: 'title' | 'brief' | 'filePath',
): string {
  return typeof scenario[key] === 'string' ? (scenario[key] as string) : '';
}

function scenarioList(
  scenario: Readonly<Record<string, unknown>>,
  key: 'acceptanceCriteria',
): readonly string[] {
  const value = scenario[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function eventTitle(event: R26CandidateEvent): string {
  if (event.type === 'SESSION_ACTIVATED') return 'Assessment activated';
  if (event.type === 'SESSION_SUBMITTED') return 'Assessment submitted';
  return 'Workspace file saved';
}

function eventDetail(event: R26CandidateEvent): string {
  const path = event.payload.path;
  return event.type === 'WORKSPACE_CHANGED' && typeof path === 'string'
    ? path
    : '';
}

function requestId(): string {
  return crypto.randomUUID();
}

function fileExtensions(path: string) {
  if (path.endsWith('.py')) return [python()];
  if (/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(path)) {
    return [javascript({ jsx: path.endsWith('x') })];
  }
  return [];
}

function makeDraft(file: R26CandidateFileView): Draft {
  return {
    path: file.path,
    content: file.content,
    baseContent: file.content,
    baseVersion: file.version,
    baseDigest: file.digest,
  };
}

export function R26CandidateClient({ sessionId }: CandidateClientProps) {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<R26CandidateGetResponse | null>(null);
  const viewRef = useRef<R26CandidateGetResponse | null>(null);
  const [acceptedConsent, setAcceptedConsent] = useState<{
    sessionId: string;
    digest: string;
  } | null>(null);
  const [selectedPathState, setSelectedPath] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingSave, setPendingSave] = useState<PendingSave | null>(null);
  const [pendingSubmit, setPendingSubmit] = useState<PendingSubmit | null>(
    null,
  );
  const [conflictLatest, setConflictLatest] =
    useState<R26CandidateFileView | null>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [loadFailure, setLoadFailure] = useState('');
  const [accessUnavailable, setAccessUnavailable] = useState(false);
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [clockNow, setClockNow] = useState(0);
  const refreshInFlight = useRef(false);
  const submitInFlight = useRef(false);
  const consentAccepted = Boolean(
    view?.dataNotice &&
    acceptedConsent?.sessionId === sessionId &&
    acceptedConsent?.digest === view.dataNotice.digest,
  );

  const [aiView, setAiView] = useState<R212CandidateAiView | null>(null);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiSubmitting, setAiSubmitting] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [lastAiPrompt, setLastAiPrompt] = useState<string | null>(null);
  const aiMessagesEndRef = useRef<HTMLDivElement | null>(null);

  const fetchAiView = useCallback(
    async (capabilityEnabled = viewRef.current?.capabilities.ai) => {
      if (!token || capabilityEnabled !== true) return;
      try {
        const response = await fetch(
          `/r26/api/candidate/${encodeURIComponent(sessionId)}/ai`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${token}`,
            },
            cache: 'no-store',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
          },
        );
        if (response.ok) {
          const data = (await response.json()) as R212CandidateAiView;
          setAiView(data);
        }
      } catch {
        // Non-blocking
      }
    },
    [sessionId, token],
  );

  const sendAiPrompt = useCallback(
    async (promptToSend?: string) => {
      const prompt = (promptToSend ?? aiPrompt).trim();
      if (
        !prompt ||
        !token ||
        viewRef.current?.capabilities.ai !== true ||
        aiSubmitting
      )
        return;

      setAiSubmitting(true);
      setAiError(null);
      setLastAiPrompt(prompt);

      const reqId = requestId();

      try {
        const response = await fetch(
          `/r26/api/candidate/${encodeURIComponent(sessionId)}/ai`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              requestId: reqId,
              candidatePrompt: prompt,
            }),
            cache: 'no-store',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
          },
        );

        const result = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;

        if (!response.ok) {
          const errorMsg =
            result?.error?.message ||
            (response.status === 429
              ? 'AI interaction budget has been exhausted.'
              : response.status === 409
                ? 'Assessment is not active or deadline expired.'
                : 'Failed to receive response from assistant.');
          setAiError(errorMsg);
          await fetchAiView();
          return;
        }

        setAiPrompt('');
        setLastAiPrompt(null);
        await fetchAiView();
        aiMessagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      } catch {
        setAiError('Network error connecting to assistant. Please retry.');
      } finally {
        setAiSubmitting(false);
      }
    },
    [aiPrompt, aiSubmitting, fetchAiView, sessionId, token],
  );

  const [executionView, setExecutionView] =
    useState<R213CandidateExecutionView | null>(null);
  const [executionViewLoading, setExecutionViewLoading] = useState(false);
  const [executionRunning, setExecutionRunning] = useState(false);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(
    null,
  );
  const [consoleOutputTab, setConsoleOutputTab] = useState<'stdout' | 'stderr'>(
    'stdout',
  );
  const executionRequestIdRef = useRef<string>(requestId());
  const lastExecutedDigestRef = useRef<string | null>(null);

  const fetchExecutionView = useCallback(
    async (capabilityEnabled = viewRef.current?.capabilities.execution) => {
      if (!token || capabilityEnabled !== true) return;
      setExecutionViewLoading(true);
      try {
        const response = await fetch(
          `/r26/api/candidate/${encodeURIComponent(sessionId)}/execution`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${token}`,
            },
            cache: 'no-store',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
          },
        );
        if (response.ok) {
          const data = (await response.json()) as R213CandidateExecutionView;
          setExecutionView(data);
        } else {
          setExecutionView(null);
        }
      } catch {
        setExecutionView(null);
      } finally {
        setExecutionViewLoading(false);
      }
    },
    [sessionId, token],
  );

  const latestExecution: R213RecordedOperation | null = useMemo(() => {
    if (!executionView?.operations || executionView.operations.length === 0)
      return null;
    if (selectedExecutionId) {
      const found = executionView.operations.find(
        (op) => op.operationId === selectedExecutionId,
      );
      if (found) return found;
    }
    return (
      executionView.operations[executionView.operations.length - 1] ?? null
    );
  }, [executionView, selectedExecutionId]);

  const isRealExecution = Boolean(
    latestExecution &&
    (latestExecution.provenance === 'restricted-executor-service' ||
      (latestExecution as { isSynthetic?: boolean }).isSynthetic === false),
  );

  const applyView = useCallback((next: R26CandidateGetResponse) => {
    viewRef.current = next;
    setView(next);
    if (next.status === 'SUBMITTED') setPendingSubmit(null);
    setServerOffsetMs(Date.parse(next.serverNow) - Date.now());
    setClockNow(Date.now());
    setLoadFailure('');
    setAccessUnavailable(false);
  }, []);

  const callApi = useCallback(
    async (
      method: 'GET' | 'POST',
      body?: Readonly<Record<string, unknown>>,
    ): Promise<R26CandidateGetResponse> => {
      if (!token)
        throw Object.assign(new Error('Candidate link required.'), {
          status: 401,
        });
      const response = await fetch(
        `/r26/api/candidate/${encodeURIComponent(sessionId)}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        },
      );
      if (!response.ok) {
        const result: unknown = await response.json().catch(() => null);
        throw errorFromResponse(response.status, result);
      }
      const result: R26CandidateGetResponse = await response.json();
      return result;
    },
    [sessionId, token],
  );

  useLayoutEffect(() => {
    let fragmentToken: string | null = null;
    const fragment = window.location.hash.slice(1);
    if (fragment) {
      try {
        const decoded = decodeURIComponent(fragment);
        if (isValidToken(decoded)) fragmentToken = decoded;
      } catch {
        fragmentToken = null;
      }
    }

    const cleanUrl = `${window.location.pathname}${window.location.search}`;
    if (window.location.hash) {
      window.history.replaceState(window.history.state, '', cleanUrl);
    }

    let storedToken: string | null = null;
    try {
      storedToken = window.sessionStorage.getItem(
        `${tokenStoragePrefix}${sessionId}`,
      );
      if (fragmentToken) {
        window.sessionStorage.setItem(
          `${tokenStoragePrefix}${sessionId}`,
          fragmentToken,
        );
      }
    } catch {
      storedToken = null;
    }
    const nextToken =
      fragmentToken ?? (isValidToken(storedToken) ? storedToken : null);
    let active = true;
    queueMicrotask(() => {
      if (active) setToken(nextToken);
    });
    return () => {
      active = false;
    };
  }, [sessionId]);

  useEffect(() => {
    if (token === undefined) return;
    if (!token) {
      let active = true;
      queueMicrotask(() => {
        if (!active) return;
        setLoadFailure(
          'This link is missing or invalid. Open the candidate link you were given.',
        );
        setLoading(false);
      });
      return () => {
        active = false;
      };
    }
    let active = true;
    void callApi('GET')
      .then((next) => {
        if (active) {
          applyView(next);
          void fetchAiView(next.capabilities.ai);
          void fetchExecutionView(next.capabilities.execution);
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        const failure = error as ApiFailure;
        setLoadFailure(
          isCandidateAccessUnavailable(failure)
            ? 'This candidate link is not available for this assessment.'
            : 'The isolated candidate workspace could not be loaded. Reload to try again.',
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [applyView, callApi, fetchAiView, fetchExecutionView, token]);

  const draftPath = draft?.path;
  const refresh = useCallback(async () => {
    if (!token || accessUnavailable || refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const next = await callApi('GET');
      applyView(next);
      if (saveConflict && draftPath) {
        const latest = next.files.find((file) => file.path === draftPath);
        if (latest) setConflictLatest(latest);
      }
      void fetchAiView(next.capabilities.ai);
      void fetchExecutionView(next.capabilities.execution);
    } catch (error) {
      const failure = error as ApiFailure;
      if (
        failure.status === 401 ||
        failure.status === 404 ||
        failure.code === 'CANDIDATE_ACCESS_DENIED'
      ) {
        setAccessUnavailable(true);
        setMessage(
          'Candidate access is no longer available. Saved work remains with the assigned hiring team. Contact the recruiter if you need help.',
        );
        return;
      }
      setMessage(
        'The latest saved state could not be refreshed. Your current editor content is still here.',
      );
    } finally {
      refreshInFlight.current = false;
    }
  }, [
    accessUnavailable,
    applyView,
    callApi,
    draftPath,
    fetchAiView,
    fetchExecutionView,
    saveConflict,
    token,
  ]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setClockNow(Date.now());
      if (viewRef.current?.status === 'ACTIVE') void refresh();
    }, 2_000);
    const clock = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => {
      window.clearInterval(interval);
      window.clearInterval(clock);
    };
  }, [refresh]);

  const selectedPath = useMemo(() => {
    if (!view || view.files.length === 0) return selectedPathState;
    if (
      selectedPathState &&
      view.files.some((file) => file.path === selectedPathState)
    ) {
      return selectedPathState;
    }
    const preferredPath = scenarioText(view.scenario, 'filePath');
    return view.files.some((file) => file.path === preferredPath)
      ? preferredPath
      : view.files[0].path;
  }, [selectedPathState, view]);
  const activeFile = useMemo(
    () => view?.files.find((file) => file.path === selectedPath) ?? null,
    [selectedPath, view],
  );
  const currentDraft = useMemo(() => {
    if (!activeFile) return null;
    if (view?.status === 'SUBMITTED') return makeDraft(activeFile);
    if (
      draft?.path === selectedPath &&
      (draft.content !== draft.baseContent ||
        draft.baseVersion === activeFile.version)
    ) {
      return draft;
    }
    return makeDraft(activeFile);
  }, [activeFile, draft, selectedPath, view?.status]);
  const isDirty = Boolean(
    currentDraft && currentDraft.content !== currentDraft.baseContent,
  );
  const scenario = view?.scenario ?? {};
  const scenarioTitle = scenarioText(scenario, 'title') || 'Assessment task';
  const brief = scenarioText(scenario, 'brief');
  const criteria = scenarioList(scenario, 'acceptanceCriteria');
  const serverAdjustedNow = clockNow + serverOffsetMs;
  const invitationExpiryMs = timestampMilliseconds(view?.invitationExpiresAt);
  const sessionDeadlineMs = timestampMilliseconds(view?.deadline);
  const activeAccessEndsAtMs =
    view?.status === 'ACTIVE'
      ? earliestTimestamp([invitationExpiryMs, sessionDeadlineMs])
      : invitationExpiryMs;
  const remainingMs =
    view?.status === 'ACTIVE' && activeAccessEndsAtMs !== null
      ? activeAccessEndsAtMs - serverAdjustedNow
      : null;
  const invitationExpired =
    invitationExpiryMs !== null && serverAdjustedNow >= invitationExpiryMs;
  const sessionTimeExpired =
    view?.status === 'ACTIVE' &&
    sessionDeadlineMs !== null &&
    serverAdjustedNow >= sessionDeadlineMs;
  const invitationEndsAccess =
    invitationExpiryMs !== null &&
    (sessionDeadlineMs === null || invitationExpiryMs <= sessionDeadlineMs);
  const submitted = view?.status === 'SUBMITTED';
  const canEdit =
    view?.status === 'ACTIVE' &&
    remainingMs !== null &&
    remainingMs > 0 &&
    !accessUnavailable;
  const editorLocked = Boolean(
    !canEdit ||
    pendingSubmit ||
    saveConflict ||
    conflictLatest ||
    (busy && !pendingSave) ||
    (pendingSave && !busy),
  );
  const isSubmittedOrExpired = Boolean(
    view?.status === 'SUBMITTED' ||
    accessUnavailable ||
    pendingSubmit ||
    invitationExpired ||
    sessionTimeExpired,
  );
  const isBudgetExhausted = Boolean(
    aiView && aiView.enabled && aiView.remainingInteractions <= 0,
  );
  const aiInputDisabled = Boolean(
    aiSubmitting ||
    pendingSubmit ||
    view?.capabilities.ai !== true ||
    isSubmittedOrExpired ||
    isBudgetExhausted ||
    !aiView?.enabled ||
    view?.status === 'CREATED',
  );

  const canRunChecks = Boolean(
    token &&
    view?.capabilities.execution === true &&
    executionView?.terminalEnabled === true &&
    executionView.remainingExecutions > 0 &&
    canEdit &&
    !pendingSubmit &&
    !busy &&
    !accessUnavailable &&
    !isDirty &&
    !pendingSave &&
    !saveConflict &&
    !executionRunning,
  );

  const runChecks = useCallback(async () => {
    if (!canRunChecks || !token || !view) return;
    setExecutionRunning(true);
    setExecutionError(null);

    // Retries use consistent request identity; changed files update expected digest
    if (lastExecutedDigestRef.current !== view.workspaceDigest) {
      executionRequestIdRef.current = requestId();
      lastExecutedDigestRef.current = view.workspaceDigest;
    }
    const currentRequestId = executionRequestIdRef.current;

    try {
      const response = await fetch(
        `/r26/api/candidate/${encodeURIComponent(sessionId)}/execution`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            requestId: currentRequestId,
            expectedWorkspaceDigest: view.workspaceDigest,
          }),
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        },
      );

      const result = (await response.json().catch(() => null)) as {
        operationId?: string;
        error?: { message?: string };
      } | null;

      if (!response.ok) {
        const errorMsg =
          result?.error?.message ||
          (response.status === 429
            ? 'Execution budget has been exhausted.'
            : response.status === 409
              ? 'Persisted workspace changed or session closed.'
              : response.status === 403
                ? 'Terminal execution is disabled for this assessment.'
                : 'Failed to run checks.');
        setExecutionError(errorMsg);
        await fetchExecutionView();
        return;
      }

      await fetchExecutionView();
      if (result?.operationId) {
        setSelectedExecutionId(result.operationId);
      }
      executionRequestIdRef.current = requestId();
    } catch {
      setExecutionError('Network error executing checks. Please retry.');
    } finally {
      setExecutionRunning(false);
    }
  }, [canRunChecks, fetchExecutionView, sessionId, token, view]);

  const activate = async () => {
    if (!view || (view.dataNotice && !consentAccepted)) {
      setMessage(
        'Review the data-use notice and confirm it before activating.',
      );
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const input: R26CandidateActivationInput = view.dataNotice
        ? {
            consent: {
              version: view.dataNotice.version,
              digest: view.dataNotice.digest,
              accepted: true,
            },
          }
        : {};
      const next = await callApi('POST', { action: 'activate', input });
      applyView(next);
      setMessage('Assessment activated. Your time has started.');
      void fetchAiView(next.capabilities.ai);
      void fetchExecutionView(next.capabilities.execution);
    } catch (error) {
      if (isCandidateAccessUnavailable(error)) {
        setAccessUnavailable(true);
        setMessage(
          'Candidate access is no longer available. Contact the recruiter if you need help.',
        );
        return;
      }
      setMessage(
        (error as Error).message || 'The assessment could not be activated.',
      );
    } finally {
      setBusy(false);
    }
  };

  const retrySave = useCallback(
    async (intent: PendingSave, automatic = false) => {
      setBusy(true);
      setMessage('');
      try {
        const next = await callApi('POST', { action: 'save', input: intent });
        const saved = next.files.find((file) => file.path === intent.path);
        applyView(next);
        if (saved) {
          if (saved.content === intent.content) {
            setDraft((current) =>
              current?.path === intent.path
                ? {
                    ...current,
                    baseContent: saved.content,
                    baseVersion: saved.version,
                    baseDigest: saved.digest,
                  }
                : current,
            );
          } else {
            setConflictLatest(saved);
            setSaveConflict(true);
          }
        }
        if (!saved) {
          setPendingSave(intent);
          setMessage(
            'The save response did not confirm this file. Retry the same save to verify it safely.',
          );
          return;
        }
        setPendingSave(null);
        if (saved?.content === intent.content) {
          setConflictLatest(null);
          setMessage(
            automatic ? 'Changes saved automatically.' : 'Work saved.',
          );
        } else if (saved) {
          setMessage(
            'Your save was accepted, and a newer saved version now exists. Your draft is preserved; resolve the version conflict before saving again.',
          );
        }
      } catch (error) {
        const failure = error as ApiFailure;
        if (isCandidateAccessUnavailable(failure)) {
          setPendingSave(null);
          setAccessUnavailable(true);
          setMessage(
            'Candidate access ended before this draft could be confirmed. The draft is still visible here, but it may not be saved; keep this page open and contact the recruiter.',
          );
        } else if (failure.status === 409) {
          setPendingSave(null);
          setSaveConflict(true);
          const latestView = await callApi('GET').catch(() => null);
          if (latestView) {
            const latest = latestView.files.find(
              (file) => file.path === intent.path,
            );
            applyView(latestView);
            if (latest) setConflictLatest(latest);
          }
          setMessage(
            'Another saved version is available. Your draft is preserved; resolve the conflict before saving again.',
          );
        } else if (failure.status && failure.status < 500) {
          setPendingSave(null);
          setMessage(failure.message || 'The work could not be saved.');
        } else {
          setPendingSave(intent);
          setMessage(
            'The save outcome is unknown. Retry the same save to confirm it safely.',
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [applyView, callApi],
  );

  const save = useCallback(
    async (automatic = false) => {
      if (
        !currentDraft ||
        !isDirty ||
        !canEdit ||
        pendingSubmit ||
        busy ||
        !activeFile
      )
        return;
      if (saveConflict) return;
      if (pendingSave) {
        await retrySave(pendingSave);
        return;
      }
      const intent: PendingSave = {
        requestId: requestId(),
        path: currentDraft.path,
        content: currentDraft.content,
        expectedVersion: currentDraft.baseVersion,
      };
      setPendingSave(intent);
      await retrySave(intent, automatic);
    },
    [
      activeFile,
      busy,
      canEdit,
      currentDraft,
      isDirty,
      pendingSave,
      pendingSubmit,
      retrySave,
      saveConflict,
    ],
  );

  useEffect(() => {
    if (
      !currentDraft ||
      !isDirty ||
      !canEdit ||
      busy ||
      pendingSubmit ||
      pendingSave ||
      saveConflict ||
      conflictLatest
    ) {
      return;
    }

    const timeout = window.setTimeout(() => void save(true), 700);
    return () => window.clearTimeout(timeout);
  }, [
    busy,
    canEdit,
    conflictLatest,
    currentDraft,
    isDirty,
    pendingSave,
    pendingSubmit,
    saveConflict,
    save,
  ]);

  useEffect(() => {
    if (!isDirty && !pendingSave && !pendingSubmit) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [isDirty, pendingSave, pendingSubmit]);

  useEffect(() => {
    const scrollers = document.querySelectorAll('.cm-scroller');
    for (const scroller of scrollers) {
      if (scroller.getAttribute('tabindex') !== '0') {
        scroller.setAttribute('tabindex', '0');
        scroller.setAttribute('role', 'region');
        scroller.setAttribute('aria-label', 'Code editor scrollable area');
      }
    }
  });

  const loadLatestVersion = () => {
    if (!conflictLatest) return;
    setSelectedPath(conflictLatest.path);
    setDraft(makeDraft(conflictLatest));
    setConflictLatest(null);
    setSaveConflict(false);
    setMessage('Loaded the latest saved version.');
  };

  const saveDraftAgainstLatest = async () => {
    if (!conflictLatest || !currentDraft || !canEdit || pendingSubmit || busy)
      return;
    const intent: PendingSave = {
      requestId: requestId(),
      path: conflictLatest.path,
      content: currentDraft.content,
      expectedVersion: conflictLatest.version,
    };
    setDraft({
      ...currentDraft,
      baseContent: conflictLatest.content,
      baseVersion: conflictLatest.version,
      baseDigest: conflictLatest.digest,
    });
    setConflictLatest(null);
    setSaveConflict(false);
    setPendingSave(intent);
    await retrySave(intent);
  };

  const submit = async () => {
    if (!view || busy || submitInFlight.current || !view.workspaceDigest)
      return;
    if (!pendingSubmit && !canEdit) return;
    if (!pendingSubmit && isDirty) {
      setMessage(
        'Your latest edits are being saved automatically. Wait until they are saved before submitting.',
      );
      return;
    }
    if (!pendingSubmit && pendingSave) {
      setMessage(
        'Confirm the pending save with Retry save before submitting the assessment.',
      );
      return;
    }
    if (!pendingSubmit && saveConflict) {
      setMessage('Resolve the saved-version conflict before submitting.');
      return;
    }
    submitInFlight.current = true;
    const intent = pendingSubmit ?? {
      requestId: requestId(),
      expectedWorkspaceDigest: view.workspaceDigest,
    };
    setPendingSubmit(intent);
    setBusy(true);
    setMessage('');
    try {
      const next = await callApi('POST', { action: 'submit', input: intent });
      applyView(next);
      setPendingSubmit(null);
      setMessage('Assessment submitted. Your saved work is now read-only.');
      void fetchAiView(next.capabilities.ai);
      void fetchExecutionView(next.capabilities.execution);
    } catch (error) {
      const failure = error as ApiFailure;
      if (isCandidateAccessUnavailable(failure)) {
        setPendingSubmit(null);
        setAccessUnavailable(true);
        setMessage(
          'Candidate access is no longer available. Submission could not be confirmed; contact the recruiter.',
        );
      } else if (failure.status && failure.status < 500) {
        setPendingSubmit(null);
        if (failure.status === 409) await refresh();
        setMessage(failure.message || 'The assessment could not be submitted.');
      } else {
        setPendingSubmit(intent);
        setMessage(
          'The submission outcome is unknown. Retry submission to confirm it safely.',
        );
      }
    } finally {
      submitInFlight.current = false;
      setBusy(false);
    }
  };

  const renderedEvents = (view?.events ?? []).map((event) => (
    <li className="r26-event" key={event.sequence}>
      <span className="r26-event-marker" aria-hidden="true" />
      <div>
        <p>{eventTitle(event)}</p>
        {eventDetail(event) ? <code>{eventDetail(event)}</code> : null}
        <time dateTime={event.timestamp}>
          {new Date(event.timestamp).toLocaleString()}
        </time>
      </div>
    </li>
  ));

  return (
    <main className="r26-candidate software-product">
      <header className="r26-header">
        <div className="r26-brand">
          <SoftwareMark />
          <strong>Hirearchy</strong>
          <span className="software-document-product">Software</span>
          <span className="r26-workspace-label">Candidate workspace</span>
        </div>
        <div className="r26-header-status">
          {view?.status === 'ACTIVE' && remainingMs !== null ? (
            <p
              className="r26-timer"
              aria-label="Workspace access time remaining"
            >
              <span>Time remaining</span>
              <strong>{formatDuration(remainingMs)}</strong>
              <span>
                Access ends no later than {formatDateTime(activeAccessEndsAtMs)}
              </span>
            </p>
          ) : null}
          {view ? (
            <span
              className={`r26-status r26-status-${accessUnavailable || invitationExpired || sessionTimeExpired ? 'expired' : view.status.toLowerCase()}`}
            >
              {accessUnavailable
                ? 'Access unavailable'
                : invitationExpired && view.status !== 'SUBMITTED'
                  ? 'Invitation expired'
                  : sessionTimeExpired
                    ? 'Time limit ended'
                    : view.status === 'CREATED'
                      ? 'Ready to start'
                      : view.status === 'ACTIVE'
                        ? 'In progress'
                        : 'Submitted'}
            </span>
          ) : null}
        </div>
      </header>

      {view ? (
        <nav className="r26-mobile-navigation" aria-label="Workspace sections">
          <a href="#candidate-code-editor">
            <IconCode size={16} aria-hidden="true" /> Workspace
          </a>
          <a href="#candidate-task-brief">
            <IconFileDescription size={16} aria-hidden="true" /> Task brief
          </a>
          <a href="#candidate-activity">
            <IconTimeline size={16} aria-hidden="true" /> Activity
          </a>
        </nav>
      ) : null}

      <div
        className="r26-workspace"
        data-session-state={view?.status.toLowerCase() ?? 'loading'}
        data-ai-enabled={
          view?.capabilities.ai === true && aiView?.enabled ? 'true' : 'false'
        }
      >
        <aside
          id="candidate-task-brief"
          className="r26-task-panel"
          aria-label="Assessment task"
          tabIndex={0}
        >
          {loading ? <p role="status">Loading assessment…</p> : null}
          {loadFailure ? (
            <div className="r26-notice r26-notice-error" role="alert">
              <p>{loadFailure}</p>
              {token ? (
                <button
                  className="r26-button r26-button-secondary"
                  onClick={() => void refresh()}
                  type="button"
                >
                  Reload workspace
                </button>
              ) : null}
            </div>
          ) : null}
          {view ? (
            <>
              {accessUnavailable ? (
                <div className="r26-notice r26-notice-error" role="alert">
                  <strong>Candidate access is no longer available</strong>
                  <p>
                    {isDirty || pendingSave
                      ? 'This draft may not have been saved. Keep this page open and contact the recruiter before closing it.'
                      : 'Saved work remains with the assigned hiring team. Contact the recruiter if you need help.'}
                  </p>
                </div>
              ) : null}
              {!accessUnavailable &&
              view.status === 'ACTIVE' &&
              remainingMs !== null &&
              remainingMs <= 0 ? (
                <div className="r26-notice r26-notice-error" role="alert">
                  <strong>
                    {invitationEndsAccess
                      ? 'Candidate invitation expired'
                      : 'Assessment time limit ended'}
                  </strong>
                  <p>
                    Candidate access is closed. Saved work remains with the
                    assigned hiring team; contact the recruiter if you need
                    help.
                  </p>
                </div>
              ) : null}
              <p className="r26-eyebrow">Engineering assessment</p>
              <h1>{scenarioTitle}</h1>
              {brief ? (
                <ScenarioBrief markdown={brief} />
              ) : (
                <p className="r26-brief">
                  The issued task details are not available in this snapshot.
                </p>
              )}
              {criteria.length > 0 ? (
                <section
                  className="r26-criteria"
                  aria-labelledby="r26-criteria-title"
                >
                  <h2 id="r26-criteria-title">Acceptance criteria</h2>
                  <ul>
                    {criteria.map((criterion, index) => (
                      <li key={`${index}-${criterion}`}>{criterion}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {view.dataNotice ? (
                <section
                  className="r26-notice"
                  aria-labelledby="candidate-data-use-title"
                  data-testid="candidate-data-use-notice"
                >
                  <strong id="candidate-data-use-title">
                    Data use and consent
                  </strong>
                  <p>{view.dataNotice.text}</p>
                  <p>
                    The task uses sample data. Saved changes and submissions
                    record the work performed in this workspace.
                  </p>
                  {view.status === 'CREATED' ? (
                    <label>
                      <input
                        checked={consentAccepted}
                        onChange={(event) => {
                          const dataNotice = view.dataNotice;
                          setAcceptedConsent(
                            event.target.checked && dataNotice
                              ? {
                                  sessionId,
                                  digest: dataNotice.digest,
                                }
                              : null,
                          );
                        }}
                        type="checkbox"
                      />{' '}
                      I acknowledge and agree to this data-use notice.
                    </label>
                  ) : null}
                </section>
              ) : null}
              {view.status === 'CREATED' ? (
                <div className="r26-prestart">
                  <p>
                    Your assessment timer starts when you activate this
                    workspace.
                    {view.invitationExpiresAt ? (
                      <>
                        {' '}
                        This invitation expires at{' '}
                        <time dateTime={view.invitationExpiresAt}>
                          {formatDateTime(invitationExpiryMs)}
                        </time>
                        .
                      </>
                    ) : null}
                  </p>
                  <button
                    className="r26-button r26-button-primary"
                    disabled={
                      busy ||
                      accessUnavailable ||
                      invitationExpired ||
                      Boolean(view.dataNotice && !consentAccepted)
                    }
                    onClick={() => void activate()}
                    type="button"
                  >
                    {busy ? 'Activating…' : 'Activate assessment'}
                  </button>
                  {view.dataNotice && !consentAccepted ? (
                    <p role="status">
                      Confirm the data-use notice to activate your assessment.
                    </p>
                  ) : null}
                </div>
              ) : null}
              {submitted ? (
                <div className="r26-notice r26-notice-success" role="status">
                  <strong>Assessment submitted</strong>
                  <p>
                    {view.closureReason === 'timeout'
                      ? 'The assessment closed when its time limit ended.'
                      : 'Your saved work has been submitted and is read-only.'}
                  </p>
                  {view.submission ? (
                    <p>
                      Workspace digest{' '}
                      <code>{view.submission.workspaceDigest}</code>
                    </p>
                  ) : null}
                </div>
              ) : null}
              <section
                className="r26-availability"
                aria-labelledby="r26-availability-title"
              >
                <h2 id="r26-availability-title">Workspace capabilities</h2>
                <ul>
                  <li>
                    <span>Code editing</span>
                    <strong>Available</strong>
                  </li>
                  <li>
                    <span>Terminal</span>
                    {view.capabilities.execution &&
                    executionView?.terminalEnabled ? (
                      <div className="r26-capability-detail">
                        <strong data-testid="terminal-capability-status">
                          Available (Synthetic Test Lane)
                        </strong>
                        <span data-testid="execution-budget-badge">
                          {executionView.remainingExecutions} of{' '}
                          {executionView.maxExecutions} runs remaining
                        </span>
                      </div>
                    ) : view.capabilities.execution &&
                      !executionView &&
                      executionViewLoading ? (
                      <strong data-testid="terminal-capability-status">
                        Checking availability…
                      </strong>
                    ) : (
                      <div className="r26-capability-detail">
                        <strong data-testid="terminal-capability-status">
                          Unavailable
                        </strong>
                        {!view.capabilities.execution ? (
                          <span className="r26-capability-note">
                            Code execution is unavailable for this assessment.
                          </span>
                        ) : null}
                      </div>
                    )}
                  </li>
                  <li>
                    <span>AI assistance</span>
                    {view.capabilities.ai && aiView?.enabled ? (
                      <div className="r26-capability-detail">
                        <strong>Available (Synthetic Test Lane)</strong>
                        <span data-testid="ai-budget-badge">
                          {aiView.remainingInteractions} of{' '}
                          {aiView.totalInteractionsAllowed} questions remaining
                        </span>
                      </div>
                    ) : view.capabilities.ai && !aiView ? (
                      <strong>Checking availability…</strong>
                    ) : (
                      <div className="r26-capability-detail">
                        <strong>Unavailable</strong>
                        <span className="r26-capability-note">
                          {view.capabilities.ai
                            ? 'AI assistance is disabled for this assessment.'
                            : 'AI assistance is unavailable in this demo.'}
                        </span>
                      </div>
                    )}
                  </li>
                  <li>
                    <span>Verification</span>
                    <strong data-testid="verification-status-badge">
                      {!view.capabilities.execution
                        ? 'Unavailable in this demo'
                        : latestExecution
                          ? `Executed (${latestExecution.status})`
                          : 'Not run'}
                    </strong>
                  </li>
                </ul>
                <p>
                  This workspace records saved code changes, task activity, and
                  submission for the assigned hiring team’s review.
                </p>
              </section>
              <section
                id="candidate-activity"
                className="r26-activity"
                aria-labelledby="r26-activity-title"
              >
                <div className="r26-section-heading">
                  <div>
                    <p className="r26-eyebrow">Recorded activity</p>
                    <h2 id="r26-activity-title">Workspace events</h2>
                  </div>
                  <button
                    className="r26-link-button"
                    onClick={() => void refresh()}
                    type="button"
                  >
                    Refresh
                  </button>
                </div>
                {renderedEvents.length ? (
                  <ol>{renderedEvents}</ol>
                ) : (
                  <p className="r26-empty">
                    Activity appears after the assessment is activated and work
                    is saved.
                  </p>
                )}
              </section>
            </>
          ) : null}
        </aside>

        <section
          id="candidate-code-editor"
          tabIndex={-1}
          className="r26-editor-panel"
          aria-label="Candidate editor"
        >
          <div className="r26-editor-heading">
            <div>
              <p className="r26-eyebrow">Workspace files</p>
              <h2>{selectedPath || 'Your code workspace'}</h2>
            </div>
            {view && view.files.length > 0 ? (
              <label className="r26-file-picker">
                <span className="sr-only">Workspace file</span>
                <select
                  aria-label="Workspace file"
                  aria-describedby="candidate-file-save-hint"
                  disabled={
                    busy ||
                    isDirty ||
                    Boolean(pendingSave) ||
                    Boolean(pendingSubmit) ||
                    saveConflict ||
                    Boolean(conflictLatest)
                  }
                  onChange={(event) => {
                    setSelectedPath(event.target.value);
                    setConflictLatest(null);
                    setMessage('');
                  }}
                  value={selectedPath}
                >
                  {view.files.map((file) => (
                    <option key={file.path} value={file.path}>
                      {file.path}
                    </option>
                  ))}
                </select>
                <span
                  id="candidate-file-save-hint"
                  className="r26-capability-note"
                >
                  {saveConflict
                    ? 'Resolve the saved-version conflict before switching files.'
                    : pendingSave
                      ? 'Confirm the pending save before switching files.'
                      : isDirty || busy
                        ? 'Wait for the current file to save before switching files.'
                        : 'Changes save automatically after you pause editing.'}
                </span>
              </label>
            ) : null}
          </div>

          {saveConflict ? (
            <div className="r26-conflict" role="alert">
              <div>
                <strong>Saved version changed</strong>
                <p>
                  {conflictLatest
                    ? 'Your draft remains here. Choose whether to load the latest version or save your draft on top of it.'
                    : 'Your draft remains here, but the latest saved version could not be loaded. Retry loading it before saving or submitting.'}
                </p>
              </div>
              <div className="r26-conflict-actions">
                {conflictLatest ? (
                  <>
                    <button
                      className="r26-button r26-button-secondary"
                      disabled={busy}
                      onClick={loadLatestVersion}
                      type="button"
                    >
                      Load latest saved version
                    </button>
                    <button
                      className="r26-button r26-button-primary"
                      disabled={busy || !canEdit}
                      onClick={() => void saveDraftAgainstLatest()}
                      type="button"
                    >
                      Save my draft against latest version
                    </button>
                  </>
                ) : (
                  <button
                    className="r26-button r26-button-secondary"
                    disabled={busy || accessUnavailable}
                    onClick={() => void refresh()}
                    type="button"
                  >
                    Reload latest saved version
                  </button>
                )}
              </div>
            </div>
          ) : null}

          <div className="r26-editor-toolbar">
            <span>
              {activeFile
                ? `Version ${activeFile.version}`
                : 'Activate the assessment to load the workspace files'}
            </span>
            <div>
              {canEdit && !pendingSubmit && activeFile ? (
                <button
                  className="r26-button r26-button-primary"
                  disabled={busy || !isDirty || saveConflict}
                  onClick={() => void save()}
                  type="button"
                >
                  {busy && pendingSave
                    ? 'Saving…'
                    : pendingSave
                      ? 'Retry save'
                      : 'Save work'}
                </button>
              ) : null}
              {canEdit || pendingSubmit ? (
                <button
                  className="r26-button r26-button-secondary"
                  disabled={
                    busy ||
                    (!pendingSubmit &&
                      (isDirty || Boolean(pendingSave) || saveConflict))
                  }
                  aria-describedby={
                    isDirty || pendingSave || saveConflict
                      ? 'candidate-submit-save-status'
                      : undefined
                  }
                  onClick={() => void submit()}
                  type="button"
                >
                  {busy && pendingSubmit
                    ? 'Submitting…'
                    : pendingSubmit
                      ? 'Retry submission'
                      : 'Submit assessment'}
                </button>
              ) : null}
            </div>
            {pendingSubmit ? (
              <p
                className="r26-capability-note"
                role="status"
                data-testid="candidate-submit-uncertain"
              >
                {busy
                  ? 'Submission is being confirmed. Editing and other actions are paused.'
                  : 'The submission outcome is unknown. Your workspace is read-only until you retry the same submission.'}
              </p>
            ) : canEdit && (isDirty || pendingSave || saveConflict) ? (
              <p
                id="candidate-submit-save-status"
                className="r26-capability-note"
                role="status"
              >
                {saveConflict
                  ? 'Submission is paused until you resolve the saved-version conflict.'
                  : pendingSave && busy
                    ? 'Submission is paused while the current save finishes.'
                    : pendingSave
                      ? 'Submission is paused. Retry the same save to confirm its result first.'
                      : 'Submission is paused while your latest edits save automatically.'}
              </p>
            ) : null}
          </div>

          {message ? (
            <p className="r26-message" role="status">
              {message}
            </p>
          ) : null}
          {view?.status === 'CREATED' ? (
            <div className="r26-editor-empty">
              <p>
                Activate the assessment to start the timer and load the issued
                workspace files.
              </p>
            </div>
          ) : activeFile && currentDraft ? (
            <div
              className="r26-code-editor"
              data-readonly={editorLocked ? 'true' : 'false'}
            >
              <CodeMirror
                aria-label="Edit file"
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: false,
                  highlightActiveLine: false,
                }}
                className="r26-code-mirror"
                editable={!editorLocked}
                extensions={[
                  ...fileExtensions(activeFile.path),
                  EditorView.lineWrapping,
                  EditorView.contentAttributes.of({
                    'aria-label': 'Edit file',
                    'aria-readonly': editorLocked ? 'true' : 'false',
                    spellcheck: 'false',
                  }),
                ]}
                onCreateEditor={(view) => {
                  if (view.scrollDOM) {
                    view.scrollDOM.setAttribute('tabindex', '0');
                    view.scrollDOM.setAttribute('role', 'region');
                    view.scrollDOM.setAttribute(
                      'aria-label',
                      'Code editor scrollable area',
                    );
                  }
                }}
                onChange={(content) => {
                  setDraft((current) => {
                    if (!currentDraft) return current;
                    const base =
                      current?.path === selectedPath &&
                      current.baseVersion === currentDraft.baseVersion
                        ? current
                        : currentDraft;
                    return { ...base, content };
                  });
                  setMessage('');
                }}
                readOnly={editorLocked}
                value={currentDraft.content}
              />
            </div>
          ) : (
            <div className="r26-editor-empty">
              <p>The issued workspace files are unavailable.</p>
            </div>
          )}

          {view && view.status === 'ACTIVE' ? (
            <div className="r26-draft-state" role="status">
              <span
                className={
                  isDirty || pendingSave ? 'r26-dot r26-dot-unsaved' : 'r26-dot'
                }
                aria-hidden="true"
              />
              {accessUnavailable
                ? 'Access ended — the current draft may not be saved'
                : saveConflict
                  ? 'Save conflict — your draft is preserved'
                  : pendingSave && busy
                    ? 'Saving changes…'
                    : pendingSave
                      ? 'Save outcome unknown — retry the same save to confirm'
                      : isDirty
                        ? 'Unsaved changes — saving automatically…'
                        : 'All changes saved'}
            </div>
          ) : null}
          {submitted ? (
            <p className="r26-readonly-note">Submitted work is read-only.</p>
          ) : null}
          {submitted &&
          draft?.path === selectedPath &&
          draft.content !== draft.baseContent &&
          draft.content !== activeFile?.content ? (
            <details className="r26-not-submitted-draft">
              <summary>View unsaved draft that was not submitted</summary>
              <p>
                The editor above shows the frozen submitted file. This local
                draft was not included in the submission.
              </p>
              <pre>{draft.content}</pre>
            </details>
          ) : null}

          {/* R2.13 Candidate Workspace Execution Panel */}
          {view && view.status !== 'CREATED' && view.capabilities.execution ? (
            <section
              className="r26-execution-panel"
              aria-label="Automated Checks"
              data-testid="candidate-execution-panel"
            >
              <div className="r26-execution-header">
                <div>
                  <div className="r26-execution-title-row">
                    <p className="r26-eyebrow" style={{ margin: 0 }}>
                      Automated Verification
                    </p>
                    <span
                      className={
                        isRealExecution
                          ? 'r26-real-executor-badge'
                          : 'r26-synthetic-badge'
                      }
                      data-testid={
                        isRealExecution
                          ? 'real-executor-badge'
                          : 'synthetic-execution-badge'
                      }
                    >
                      {isRealExecution
                        ? 'Real Restricted Executor (Dev)'
                        : '[Synthetic Test Result · Test Lane] · Synthetic Execution Adapter'}
                    </span>
                  </div>
                  <h2>Approved Checks Runner</h2>
                </div>
                <div className="r26-execution-actions">
                  <div className="r26-execution-meta">
                    <span
                      className="r26-execution-version"
                      data-testid="execution-workspace-version"
                    >
                      Saved version {activeFile?.version ?? 'Unknown'} · Digest{' '}
                      {view.workspaceDigest
                        ? view.workspaceDigest.slice(0, 8)
                        : '—'}
                    </span>
                    <span
                      className="r26-execution-budget-pill"
                      data-testid="execution-panel-budget"
                    >
                      {executionView?.terminalEnabled
                        ? `${executionView.remainingExecutions} of ${executionView.maxExecutions} runs remaining`
                        : executionViewLoading
                          ? 'Checking run availability…'
                          : 'Run availability could not be confirmed'}
                    </span>
                  </div>
                  <button
                    className="r26-button r26-button-primary r26-run-checks-btn"
                    data-testid="run-checks-button"
                    disabled={!canRunChecks}
                    onClick={() => void runChecks()}
                    type="button"
                  >
                    {executionRunning ? 'Running checks…' : 'Run checks'}
                  </button>
                </div>
              </div>

              {isDirty ? (
                <p className="r26-execution-hint" role="status">
                  Save your changes first to run checks against the persisted
                  workspace snapshot.
                </p>
              ) : null}

              {executionError ? (
                <div
                  className="r26-notice r26-notice-error"
                  role="alert"
                  data-testid="execution-error-notice"
                >
                  <p>{executionError}</p>
                </div>
              ) : null}

              <div className="r26-execution-status-bar">
                <span className="r26-status-label">Status:</span>
                <span
                  className={`r26-execution-state-badge state-${
                    executionRunning
                      ? 'running'
                      : executionError
                        ? 'error'
                        : !latestExecution
                          ? 'never'
                          : latestExecution.isUnknown ||
                              latestExecution.status === 'UNKNOWN'
                            ? 'unknown'
                            : latestExecution.status.toLowerCase()
                  }`}
                  data-testid="execution-state-badge"
                >
                  {executionRunning
                    ? 'Running checks…'
                    : executionError
                      ? 'Request error'
                      : !latestExecution
                        ? 'Never executed'
                        : latestExecution.isUnknown ||
                            latestExecution.status === 'UNKNOWN'
                          ? 'Unknown execution status'
                          : latestExecution.status === 'TIMED_OUT'
                            ? 'Timed out'
                            : latestExecution.status === 'FAILED'
                              ? `Failed (Exit ${latestExecution.exitCode ?? 1})`
                              : latestExecution.status === 'COMPLETED'
                                ? latestExecution.exitCode === 0
                                  ? 'Passed (Exit 0)'
                                  : `Failed (Exit ${latestExecution.exitCode})`
                                : latestExecution.status}
                </span>

                {latestExecution?.isUnknown ||
                latestExecution?.status === 'UNKNOWN' ? (
                  <span
                    className="r26-unknown-pill"
                    data-testid="execution-unknown-warning"
                  >
                    [UNKNOWN EXECUTION STATE]
                  </span>
                ) : null}

                {latestExecution?.failureReason ? (
                  <span
                    className="r26-failure-reason-pill"
                    data-testid="execution-failure-reason-pill"
                  >
                    Reason: {latestExecution.failureReason}
                  </span>
                ) : null}

                {latestExecution?.cleanupStatus ? (
                  <span
                    className={`r26-cleanup-pill cleanup-${latestExecution.cleanupStatus.toLowerCase()}`}
                    data-testid="execution-cleanup-pill"
                  >
                    Cleanup: {latestExecution.cleanupStatus}
                  </span>
                ) : null}

                {latestExecution?.durationMs !== null &&
                latestExecution?.durationMs !== undefined ? (
                  <span
                    className="r26-execution-duration"
                    data-testid="execution-duration"
                  >
                    Duration: {latestExecution.durationMs}ms
                  </span>
                ) : null}
              </div>

              {/* Console / Terminal Area */}
              <div
                className="r26-terminal-console"
                data-testid="execution-output-console"
              >
                <div className="r26-terminal-console-header">
                  <div className="r26-console-tabs" role="tablist">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={consoleOutputTab === 'stdout'}
                      className={`r26-console-tab ${consoleOutputTab === 'stdout' ? 'active' : ''}`}
                      data-testid="stdout-tab"
                      onClick={() => setConsoleOutputTab('stdout')}
                    >
                      STDOUT
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={consoleOutputTab === 'stderr'}
                      className={`r26-console-tab ${consoleOutputTab === 'stderr' ? 'active' : ''}`}
                      data-testid="stderr-tab"
                      onClick={() => setConsoleOutputTab('stderr')}
                    >
                      STDERR
                    </button>
                  </div>
                  <div className="r26-terminal-console-meta">
                    {latestExecution?.exitCode !== null &&
                    latestExecution?.exitCode !== undefined ? (
                      <span
                        className={`r26-exit-pill ${latestExecution.exitCode === 0 ? 'exit-zero' : 'exit-fail'}`}
                        data-testid="execution-exit-code-pill"
                      >
                        Exit {latestExecution.exitCode}
                      </span>
                    ) : null}
                    {(consoleOutputTab === 'stdout' &&
                      latestExecution?.truncatedStdout) ||
                    (consoleOutputTab === 'stderr' &&
                      latestExecution?.truncatedStderr) ? (
                      <span
                        className="r26-truncation-pill"
                        data-testid="execution-truncated-notice"
                      >
                        [Output truncated at limit]
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="r26-terminal-body">
                  <pre
                    className="r26-terminal-output"
                    data-testid={
                      consoleOutputTab === 'stdout'
                        ? 'execution-stdout'
                        : 'execution-stderr'
                    }
                  >
                    {!latestExecution
                      ? '(No checks have been executed yet)'
                      : consoleOutputTab === 'stdout'
                        ? latestExecution.stdout || '(No standard output)'
                        : latestExecution.stderr || '(No standard error)'}
                  </pre>
                </div>
              </div>

              {/* Execution Receipt & Provenance */}
              {latestExecution ? (
                <details
                  className="r26-execution-receipt-details"
                  data-testid="execution-receipt"
                >
                  <summary>
                    {isRealExecution
                      ? 'View stored restricted executor receipt'
                      : 'View stored synthetic execution receipt'}
                  </summary>
                  <dl className="r26-receipt-dl">
                    <div>
                      <dt>Execution Mode</dt>
                      <dd>
                        <span
                          className={
                            isRealExecution
                              ? 'r26-receipt-badge r26-receipt-badge-real'
                              : 'r26-receipt-badge r26-receipt-badge-synthetic'
                          }
                          data-testid="receipt-execution-mode"
                        >
                          {isRealExecution
                            ? 'Real Restricted Executor (Dev)'
                            : 'Synthetic Execution Adapter'}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt>Operation ID</dt>
                      <dd>
                        <code>{latestExecution.operationId}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Recipe ID</dt>
                      <dd>
                        <code>
                          {latestExecution.recipeId} (v
                          {latestExecution.recipeVersion})
                        </code>
                      </dd>
                    </div>
                    <div>
                      <dt>Workspace Digest</dt>
                      <dd>
                        <code style={{ wordBreak: 'break-all' }}>
                          {latestExecution.workspaceDigest}
                        </code>
                      </dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>
                        <code data-testid="receipt-status">
                          {latestExecution.status}
                        </code>
                      </dd>
                    </div>
                    <div>
                      <dt>Exit Code</dt>
                      <dd>
                        <code data-testid="receipt-exit-code">
                          {latestExecution.exitCode !== null &&
                          latestExecution.exitCode !== undefined
                            ? String(latestExecution.exitCode)
                            : 'null (None)'}
                        </code>
                      </dd>
                    </div>
                    <div>
                      <dt>Duration</dt>
                      <dd>
                        <span data-testid="receipt-duration">
                          {latestExecution.durationMs !== null &&
                          latestExecution.durationMs !== undefined
                            ? `${latestExecution.durationMs}ms`
                            : 'Unavailable'}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt>Cleanup Status</dt>
                      <dd>
                        <code data-testid="receipt-cleanup-status">
                          {latestExecution.cleanupStatus}
                        </code>
                      </dd>
                    </div>
                    <div>
                      <dt>Provenance</dt>
                      <dd>
                        <code data-testid="receipt-provenance">
                          {latestExecution.provenance}
                        </code>
                      </dd>
                    </div>
                    {latestExecution.failureReason ? (
                      <div>
                        <dt>Failure Reason</dt>
                        <dd>
                          <code data-testid="receipt-failure-reason">
                            {latestExecution.failureReason}
                          </code>
                        </dd>
                      </div>
                    ) : null}
                    {latestExecution.errorMessage ? (
                      <div>
                        <dt>Error Message</dt>
                        <dd>
                          <code data-testid="receipt-error-message">
                            {latestExecution.errorMessage}
                          </code>
                        </dd>
                      </div>
                    ) : null}
                    {latestExecution.stdoutDigest ? (
                      <div>
                        <dt>Stdout Digest</dt>
                        <dd>
                          <code style={{ wordBreak: 'break-all' }}>
                            {latestExecution.stdoutDigest}
                          </code>
                        </dd>
                      </div>
                    ) : null}
                    {latestExecution.stderrDigest ? (
                      <div>
                        <dt>Stderr Digest</dt>
                        <dd>
                          <code style={{ wordBreak: 'break-all' }}>
                            {latestExecution.stderrDigest}
                          </code>
                        </dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>Timestamp</dt>
                      <dd>
                        <time dateTime={latestExecution.createdAt}>
                          {latestExecution.createdAt}
                        </time>
                      </dd>
                    </div>
                  </dl>
                </details>
              ) : null}

              {/* Prior execution runs history */}
              {executionView?.operations &&
              executionView.operations.length > 1 ? (
                <div
                  className="r26-execution-history"
                  data-testid="execution-history-list"
                >
                  <h4>Run History</h4>
                  <ul className="r26-history-list">
                    {[...executionView.operations].reverse().map((op, idx) => (
                      <li key={op.operationId || op.requestId}>
                        <button
                          type="button"
                          className={`r26-history-item-btn ${selectedExecutionId === op.operationId || (!selectedExecutionId && op.operationId === latestExecution?.operationId) ? 'selected' : ''}`}
                          onClick={() => setSelectedExecutionId(op.operationId)}
                        >
                          <span>
                            Run #{executionView.operations.length - idx}
                          </span>
                          <span>
                            {op.exitCode === 0
                              ? 'Passed (Exit 0)'
                              : `Exit ${op.exitCode ?? '—'}`}
                          </span>
                          <time dateTime={op.createdAt}>
                            {new Date(op.createdAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                            })}
                          </time>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          ) : null}
        </section>

        {view?.capabilities.ai === true ? (
          <aside
            className={`r26-ai-panel ${view.capabilities.ai !== true || !aiView?.enabled ? 'r26-ai-panel-disabled' : ''}`}
            aria-label="AI assistance"
            data-testid="candidate-ai-panel"
          >
            <div className="r26-ai-heading">
              <div>
                <p
                  className="r26-eyebrow"
                  style={{ color: 'rgba(255,255,255,0.7)', margin: 0 }}
                >
                  AI Assistance
                </p>
                <h2>
                  {view.capabilities.ai
                    ? 'Synthetic Assistant (Test Lane)'
                    : 'Unavailable in this demo'}
                </h2>
              </div>
              {view.capabilities.ai && aiView?.enabled ? (
                <span
                  className="r26-ai-budget-pill"
                  data-testid="ai-panel-budget"
                  title="Remaining questions in budget"
                >
                  {aiView.remainingInteractions} of{' '}
                  {aiView.totalInteractionsAllowed} remaining
                </span>
              ) : null}
            </div>

            {!view.capabilities.ai ? (
              <div
                className="r26-ai-disabled-body"
                data-testid="ai-disabled-notice"
              >
                <p>AI assistance is unavailable in this demo.</p>
              </div>
            ) : !aiView ? (
              <div className="r26-ai-disabled-body">
                <p>Loading AI assistance…</p>
              </div>
            ) : !aiView.enabled ? (
              <div
                className="r26-ai-disabled-body"
                data-testid="ai-disabled-notice"
              >
                <p>AI assistance is disabled for this assessment.</p>
              </div>
            ) : (
              <>
                <div
                  className="r26-ai-messages"
                  role="log"
                  aria-live="polite"
                  data-testid="ai-messages-container"
                >
                  {aiView.interactions.length === 0 ? (
                    <div className="r26-ai-empty">
                      <p>No questions asked yet.</p>
                      <p className="r26-ai-hint">
                        Ask questions regarding the task, requirements, or
                        architecture. Answers are generated factually by the
                        Synthetic Assistant test lane.
                      </p>
                    </div>
                  ) : (
                    aiView.interactions.map((interaction) => (
                      <div
                        key={interaction.interactionId || interaction.requestId}
                        className="r26-ai-thread"
                        data-testid={`ai-interaction-${interaction.requestId}`}
                      >
                        <div
                          className="r26-ai-message r26-ai-message-candidate"
                          data-testid="ai-candidate-message"
                        >
                          <div className="r26-ai-meta">
                            <strong>You</strong>
                            {interaction.createdAt ? (
                              <time dateTime={interaction.createdAt}>
                                {new Date(
                                  interaction.createdAt,
                                ).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                  second: '2-digit',
                                })}
                              </time>
                            ) : null}
                          </div>
                          <p>{interaction.candidatePrompt}</p>
                        </div>

                        {interaction.status === 'COMPLETED' &&
                        interaction.assistantResponse ? (
                          <div
                            className="r26-ai-message r26-ai-message-assistant"
                            data-testid="ai-assistant-message"
                          >
                            <div className="r26-ai-meta">
                              <strong>Synthetic Assistant (Test Lane)</strong>
                              {interaction.completedAt ? (
                                <time dateTime={interaction.completedAt}>
                                  {new Date(
                                    interaction.completedAt,
                                  ).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    second: '2-digit',
                                  })}
                                </time>
                              ) : null}
                            </div>
                            <p>{interaction.assistantResponse}</p>
                          </div>
                        ) : interaction.status === 'FAILED' ? (
                          <div
                            className="r26-ai-message r26-ai-message-failed"
                            data-testid="ai-failed-message"
                          >
                            <div className="r26-ai-meta">
                              <strong>
                                Synthetic Assistant (Test Lane) — Error
                              </strong>
                            </div>
                            <p>
                              {interaction.errorMessage ||
                                interaction.failureReason ||
                                'Failed to generate response.'}
                            </p>
                          </div>
                        ) : null}
                      </div>
                    ))
                  )}
                  <div ref={aiMessagesEndRef} />
                </div>

                {aiSubmitting ? (
                  <div
                    className="r26-ai-loading"
                    role="status"
                    data-testid="ai-loading-indicator"
                  >
                    <span className="r26-ai-spinner" aria-hidden="true" />
                    <span>Generating response from Synthetic Assistant…</span>
                  </div>
                ) : null}

                {aiError ? (
                  <div
                    className="r26-notice r26-notice-error"
                    role="alert"
                    style={{ margin: '0 1rem 0.5rem' }}
                    data-testid="ai-error-notice"
                  >
                    <strong>Error</strong>
                    <p>{aiError}</p>
                    {lastAiPrompt &&
                    !aiSubmitting &&
                    !isBudgetExhausted &&
                    !isSubmittedOrExpired ? (
                      <button
                        type="button"
                        className="r26-button r26-button-secondary"
                        onClick={() => void sendAiPrompt(lastAiPrompt)}
                        style={{ marginTop: '0.4rem', alignSelf: 'flex-start' }}
                      >
                        Retry
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {isSubmittedOrExpired ? (
                  <div
                    className="r26-notice"
                    style={{ margin: '0 1rem 0.75rem' }}
                    data-testid="ai-finality-notice"
                  >
                    <strong>Assessment concluded</strong>
                    <p>
                      {pendingSubmit
                        ? 'Submission is being confirmed. AI actions are paused.'
                        : view?.closureReason === 'timeout' ||
                            (remainingMs !== null && remainingMs <= 0)
                          ? 'Assessment time has expired. AI assistance is now closed.'
                          : submitted
                            ? 'Assessment has been submitted. AI assistance is read-only.'
                            : 'Candidate actions are paused.'}
                    </p>
                  </div>
                ) : isBudgetExhausted ? (
                  <div
                    className="r26-notice"
                    style={{ margin: '0 1rem 0.75rem' }}
                    data-testid="ai-budget-exhausted-notice"
                  >
                    <strong>Interaction budget exhausted</strong>
                    <p>
                      You have reached the maximum allowance of{' '}
                      {aiView.totalInteractionsAllowed} questions for this
                      assessment.
                    </p>
                  </div>
                ) : view?.status === 'CREATED' ? (
                  <div
                    className="r26-notice"
                    style={{ margin: '0 1rem 0.75rem' }}
                    data-testid="ai-prestart-notice"
                  >
                    <strong>Assessment not active</strong>
                    <p>Activate the assessment above to ask questions.</p>
                  </div>
                ) : (
                  <form
                    className="r26-ai-composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void sendAiPrompt();
                    }}
                  >
                    <label htmlFor="r26-ai-prompt-input" className="sr-only">
                      Ask the Synthetic Assistant
                    </label>
                    <textarea
                      id="r26-ai-prompt-input"
                      className="r26-ai-textarea"
                      placeholder="Ask a question about your task (max 4,000 characters)…"
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      disabled={aiInputDisabled}
                      maxLength={4000}
                      rows={3}
                    />
                    <div className="r26-ai-composer-footer">
                      <span className="r26-ai-char-counter">
                        {aiPrompt.length} / 4,000
                      </span>
                      <button
                        type="submit"
                        className="r26-button r26-button-primary"
                        disabled={aiInputDisabled || !aiPrompt.trim()}
                        data-testid="ai-submit-button"
                      >
                        {aiSubmitting ? 'Sending…' : 'Ask Assistant'}
                      </button>
                    </div>
                  </form>
                )}
              </>
            )}
          </aside>
        ) : null}
      </div>
    </main>
  );
}
