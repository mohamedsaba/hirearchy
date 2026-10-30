'use client';

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

import type {
  R26CandidateEvent,
  R26CandidateFileView,
  R26CandidateView,
} from '../../../../../../database/postgres/r26/adapter.mjs';
import type { R212CandidateAiView } from '../../../../src/r212-ai/contract';
import type {
  R213CandidateExecutionView,
  R213RecordedOperation,
} from '../../../../src/r213-execution/contract';
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
  const [view, setView] = useState<R26CandidateView | null>(null);
  const viewRef = useRef<R26CandidateView | null>(null);
  const [selectedPathState, setSelectedPath] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingSave, setPendingSave] = useState<PendingSave | null>(null);
  const [pendingSubmit, setPendingSubmit] = useState<PendingSubmit | null>(
    null,
  );
  const [conflictLatest, setConflictLatest] =
    useState<R26CandidateFileView | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [loadFailure, setLoadFailure] = useState('');
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [clockNow, setClockNow] = useState(0);
  const refreshInFlight = useRef(false);

  const [aiView, setAiView] = useState<R212CandidateAiView | null>(null);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiSubmitting, setAiSubmitting] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [lastAiPrompt, setLastAiPrompt] = useState<string | null>(null);
  const aiMessagesEndRef = useRef<HTMLDivElement | null>(null);

  const fetchAiView = useCallback(async () => {
    if (!token) return;
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
  }, [sessionId, token]);

  const sendAiPrompt = useCallback(
    async (promptToSend?: string) => {
      const prompt = (promptToSend ?? aiPrompt).trim();
      if (!prompt || !token || aiSubmitting) return;

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

  const fetchExecutionView = useCallback(async () => {
    if (!token) return;
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
      }
    } catch {
      // Non-blocking
    }
  }, [sessionId, token]);

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

  const applyView = useCallback((next: R26CandidateView) => {
    viewRef.current = next;
    setView(next);
    setServerOffsetMs(Date.parse(next.serverNow) - Date.now());
    setClockNow(Date.now());
    setLoadFailure('');
  }, []);

  const callApi = useCallback(
    async (
      method: 'GET' | 'POST',
      body?: Readonly<Record<string, unknown>>,
    ): Promise<R26CandidateView> => {
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
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) throw errorFromResponse(response.status, result);
      return result as R26CandidateView;
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
          void fetchAiView();
          void fetchExecutionView();
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        const failure = error as ApiFailure;
        setLoadFailure(
          failure.status === 401 || failure.status === 404
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

  const refresh = useCallback(async () => {
    if (!token || refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      applyView(await callApi('GET'));
      void fetchAiView();
      void fetchExecutionView();
    } catch {
      setMessage(
        'The latest saved state could not be refreshed. Your current editor content is still here.',
      );
    } finally {
      refreshInFlight.current = false;
    }
  }, [applyView, callApi, fetchAiView, fetchExecutionView, token]);

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
  const remainingMs =
    view?.deadline && view.status === 'ACTIVE'
      ? Date.parse(view.deadline) - (clockNow + serverOffsetMs)
      : null;
  const submitted = view?.status === 'SUBMITTED';
  const canEdit =
    view?.status === 'ACTIVE' && remainingMs !== null && remainingMs > 0;
  const isSubmittedOrExpired = Boolean(
    view?.status === 'SUBMITTED' ||
    (view?.status === 'ACTIVE' && remainingMs !== null && remainingMs <= 0),
  );
  const isBudgetExhausted = Boolean(
    aiView && aiView.enabled && aiView.remainingInteractions <= 0,
  );
  const aiInputDisabled = Boolean(
    aiSubmitting ||
    isSubmittedOrExpired ||
    isBudgetExhausted ||
    !aiView?.enabled ||
    view?.status === 'CREATED',
  );

  const runChecks = useCallback(async () => {
    if (!token || !view || executionRunning || isDirty || pendingSave) return;
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
  }, [
    executionRunning,
    fetchExecutionView,
    isDirty,
    pendingSave,
    sessionId,
    token,
    view,
  ]);

  const activate = async () => {
    setBusy(true);
    setMessage('');
    try {
      applyView(await callApi('POST', { action: 'activate', input: {} }));
      setMessage('Assessment activated. Your time has started.');
      void fetchAiView();
      void fetchExecutionView();
    } catch (error) {
      setMessage(
        (error as Error).message || 'The assessment could not be activated.',
      );
    } finally {
      setBusy(false);
    }
  };

  const retrySave = async (intent: PendingSave) => {
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
        }
      }
      setPendingSave(null);
      if (saved?.content === intent.content) {
        setConflictLatest(null);
        setMessage('Work saved.');
      } else if (saved) {
        setMessage(
          'Your save was accepted, and a newer saved version now exists. Your draft is preserved; resolve the version conflict before saving again.',
        );
      } else {
        setMessage('Work saved.');
      }
    } catch (error) {
      const failure = error as ApiFailure;
      if (failure.status === 409) {
        setPendingSave(null);
        const latestView = await callApi('GET').catch(() => null);
        if (latestView) {
          const latest = latestView.files.find(
            (file) => file.path === intent.path,
          );
          applyView(latestView);
          if (latest) setConflictLatest(latest);
        }
        setMessage(
          'Another saved version is available. Choose how to resolve the conflict before saving again.',
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
  };

  const save = async () => {
    if (!currentDraft || !isDirty || !canEdit || busy || !activeFile) return;
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
    await retrySave(intent);
  };

  const loadLatestVersion = () => {
    if (!conflictLatest) return;
    setSelectedPath(conflictLatest.path);
    setDraft(makeDraft(conflictLatest));
    setConflictLatest(null);
    setMessage('Loaded the latest saved version.');
  };

  const saveDraftAgainstLatest = async () => {
    if (!conflictLatest || !currentDraft || !canEdit || busy) return;
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
    setPendingSave(intent);
    await retrySave(intent);
  };

  const submit = async () => {
    if (!view || !canEdit || busy || !view.workspaceDigest) return;
    if (isDirty) {
      setMessage('Save your changes before submitting the assessment.');
      return;
    }
    if (pendingSave) {
      setMessage('Confirm the pending save before submitting the assessment.');
      return;
    }
    const intent = pendingSubmit ?? {
      requestId: requestId(),
      expectedWorkspaceDigest: view.workspaceDigest,
    };
    setPendingSubmit(intent);
    setBusy(true);
    setMessage('');
    try {
      applyView(await callApi('POST', { action: 'submit', input: intent }));
      setPendingSubmit(null);
      setMessage('Assessment submitted. Your saved work is now read-only.');
      void fetchAiView();
      void fetchExecutionView();
    } catch (error) {
      const failure = error as ApiFailure;
      if (failure.status && failure.status < 500) {
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
          <span className="r26-brand-mark" aria-hidden="true">
            H
          </span>
          <div>
            <strong>Hirearchy Software</strong>
            <span>Candidate workspace</span>
          </div>
        </div>
        <div className="r26-header-status">
          {view?.status === 'ACTIVE' && remainingMs !== null ? (
            <p className="r26-timer" aria-label="Assessment timer">
              <span>Time remaining</span>
              <strong>{formatDuration(remainingMs)}</strong>
            </p>
          ) : null}
          {view ? (
            <span
              className={`r26-status r26-status-${view.status.toLowerCase()}`}
            >
              {view.status === 'CREATED'
                ? 'Ready to start'
                : view.status === 'ACTIVE'
                  ? 'In progress'
                  : 'Submitted'}
            </span>
          ) : null}
        </div>
      </header>

      <div
        className="r26-workspace"
        data-ai-enabled={aiView?.enabled ? 'true' : 'false'}
      >
        <aside className="r26-task-panel" aria-label="Assessment task">
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
              <p className="r26-eyebrow">Engineering assessment</p>
              <h1>{scenarioTitle}</h1>
              {brief ? (
                <p className="r26-brief">{brief}</p>
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
              {view.status === 'CREATED' ? (
                <div className="r26-prestart">
                  <p>
                    Your assessment timer starts when you activate this
                    workspace.
                  </p>
                  <button
                    className="r26-button r26-button-primary"
                    disabled={busy}
                    onClick={() => void activate()}
                    type="button"
                  >
                    {busy ? 'Activating…' : 'Activate assessment'}
                  </button>
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
                    {executionView?.terminalEnabled ? (
                      <div className="r26-capability-detail">
                        <strong data-testid="terminal-capability-status">
                          Available (Synthetic Test Lane)
                        </strong>
                        <span data-testid="execution-budget-badge">
                          {executionView.remainingExecutions} of{' '}
                          {executionView.maxExecutions} runs remaining
                        </span>
                      </div>
                    ) : (
                      <strong data-testid="terminal-capability-status">
                        Unavailable
                      </strong>
                    )}
                  </li>
                  <li>
                    <span>AI assistance</span>
                    {aiView?.enabled ? (
                      <div className="r26-capability-detail">
                        <strong>Available (Synthetic Test Lane)</strong>
                        <span data-testid="ai-budget-badge">
                          {aiView.remainingInteractions} of{' '}
                          {aiView.totalInteractionsAllowed} questions remaining
                        </span>
                      </div>
                    ) : (
                      <div className="r26-capability-detail">
                        <strong>Unavailable</strong>
                        <span className="r26-capability-note">
                          AI assistance is disabled for this assessment.
                        </span>
                      </div>
                    )}
                  </li>
                  <li>
                    <span>Verification</span>
                    <strong data-testid="verification-status-badge">
                      {latestExecution
                        ? `Executed (${latestExecution.status})`
                        : 'Not run'}
                    </strong>
                  </li>
                </ul>
                <p>
                  This isolated workspace records saved file changes, synthetic
                  verification receipts, and candidate interactions.
                </p>
              </section>
              <section
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

        <section className="r26-editor-panel" aria-label="Candidate editor">
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
                  disabled={busy || isDirty}
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
              </label>
            ) : null}
          </div>

          {conflictLatest ? (
            <div className="r26-conflict" role="alert">
              <div>
                <strong>Saved version changed</strong>
                <p>
                  Your draft remains here. Choose whether to load the latest
                  version or save your draft on top of it.
                </p>
              </div>
              <div className="r26-conflict-actions">
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
              {canEdit && activeFile ? (
                <button
                  className="r26-button r26-button-primary"
                  disabled={busy || !isDirty}
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
              {canEdit ? (
                <button
                  className="r26-button r26-button-secondary"
                  disabled={busy || isDirty || Boolean(pendingSave)}
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
              data-readonly={canEdit ? 'false' : 'true'}
            >
              <CodeMirror
                aria-label="Edit file"
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: false,
                  highlightActiveLine: false,
                }}
                className="r26-code-mirror"
                editable={Boolean(canEdit && !busy && !pendingSave)}
                extensions={[
                  ...fileExtensions(activeFile.path),
                  EditorView.contentAttributes.of({
                    'aria-label': 'Edit file',
                    'aria-readonly':
                      canEdit && !busy && !pendingSave ? 'false' : 'true',
                    spellcheck: 'false',
                  }),
                ]}
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
                readOnly={!canEdit || busy || Boolean(pendingSave)}
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
                className={isDirty ? 'r26-dot r26-dot-unsaved' : 'r26-dot'}
                aria-hidden="true"
              />
              {isDirty ? 'Unsaved changes' : 'All changes saved'}
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
          {view && view.status !== 'CREATED' ? (
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
                      Saved version {activeFile?.version ?? '1'} · Digest{' '}
                      {view.workspaceDigest
                        ? view.workspaceDigest.slice(0, 8)
                        : '—'}
                    </span>
                    <span
                      className="r26-execution-budget-pill"
                      data-testid="execution-panel-budget"
                    >
                      {executionView
                        ? `${executionView.remainingExecutions} of ${executionView.maxExecutions} runs remaining`
                        : '10 of 10 runs remaining'}
                    </span>
                  </div>
                  <button
                    className="r26-button r26-button-primary r26-run-checks-btn"
                    data-testid="run-checks-button"
                    disabled={
                      !canEdit ||
                      busy ||
                      isDirty ||
                      Boolean(pendingSave) ||
                      executionRunning ||
                      (executionView !== null &&
                        executionView.remainingExecutions <= 0)
                    }
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

        <aside
          className={`r26-ai-panel ${!aiView?.enabled ? 'r26-ai-panel-disabled' : ''}`}
          aria-label="AI Assistance"
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
              <h2>Synthetic Assistant (Test Lane)</h2>
            </div>
            {aiView?.enabled ? (
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

          {!aiView ? (
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
                    {view?.closureReason === 'timeout' ||
                    (remainingMs !== null && remainingMs <= 0)
                      ? 'Assessment time has expired. AI assistance is now closed.'
                      : 'Assessment has been submitted. AI assistance is read-only.'}
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
      </div>
    </main>
  );
}
