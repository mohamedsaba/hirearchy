'use client';

import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import {
  IconArrowRight,
  IconCheck,
  IconChevronRight,
  IconCircleCheck,
  IconClock,
  IconCode,
  IconFile,
  IconFileCode,
  IconFolder,
  IconFolderOpen,
  IconLayoutSidebarRight,
  IconLoader2,
  IconMessageCode,
  IconPlayerPlay,
  IconSettings2,
  IconTerminal2,
  IconX,
} from '@tabler/icons-react';

import type { R26CandidateFileView } from '../../../../../../database/postgres/r26/adapter.mjs';
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
import { HorizontalTabs } from '../../../_components/horizontal-tabs';
import { LocalTime } from '../../../_components/local-time';
import { formatLocalDateTime } from '../../../../src/ui/relative-time';
import { CommonThreadLoader } from '../../../_components/common-thread-loader';
import {
  CommonThreadToast,
  type CommonThreadToastTone,
} from '../../../_components/common-thread-toast';
import {
  ThemeToggle,
  useHirearchyTheme,
} from '../../../_components/theme-toggle';
import './candidate-workspace.css';

const CodeEditorSurface = dynamic(
  () => import('./code-editor-surface').then((m) => m.CodeEditorSurface),
  {
    ssr: false,
    loading: () => (
      <div style={{ padding: '1.5rem' }}>
        <CommonThreadLoader compact label="Preparing editor…" />
      </div>
    ),
  },
);

export type CandidateAccountGate = Readonly<{
  state:
    | 'ready'
    | 'sign_in_required'
    | 'profile_required'
    | 'email_mismatch'
    | 'unavailable';
  signedInEmail?: string;
  candidateName?: string;
  candidateCode?: string;
}>;

type CandidateClientProps = Readonly<{
  sessionId: string;
  accountGate?: CandidateAccountGate;
}>;

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
  const pad = (value: number) => String(value).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(remainingSeconds)}`;
  }
  return `${pad(minutes)}:${pad(remainingSeconds)}`;
}

type FileTreeNode =
  | Readonly<{
      kind: 'folder';
      name: string;
      path: string;
      children: FileTreeNode[];
    }>
  | Readonly<{
      kind: 'file';
      name: string;
      path: string;
    }>;

function sortFileTree(nodes: FileTreeNode[]): FileTreeNode[] {
  return [...nodes]
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((node) =>
      node.kind === 'folder'
        ? { ...node, children: sortFileTree(node.children) }
        : node,
    );
}

function buildFileTree(files: readonly R26CandidateFileView[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const folderMap = new Map<
    string,
    { kind: 'folder'; name: string; path: string; children: FileTreeNode[] }
  >();

  for (const file of files) {
    const segments = file.path.split('/').filter(Boolean);
    if (segments.length <= 1) {
      root.push({ kind: 'file', name: file.path, path: file.path });
      continue;
    }

    let parentChildren = root;
    let accumulatedPath = '';
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      accumulatedPath = accumulatedPath
        ? `${accumulatedPath}/${segment}`
        : segment;
      let folder = folderMap.get(accumulatedPath);
      if (!folder) {
        folder = {
          kind: 'folder',
          name: segment,
          path: accumulatedPath,
          children: [],
        };
        folderMap.set(accumulatedPath, folder);
        parentChildren.push(folder);
      }
      parentChildren = folder.children;
    }

    parentChildren.push({
      kind: 'file',
      name: segments[segments.length - 1],
      path: file.path,
    });
  }

  return sortFileTree(root);
}

function fileBasename(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index >= 0 ? filePath.slice(index + 1) : filePath;
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

function requestId(): string {
  return crypto.randomUUID();
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

const EDITOR_FONT_SIZES = [12, 13, 14, 15, 16, 18] as const;

type EditorFontSize = (typeof EDITOR_FONT_SIZES)[number];

const draftsStoragePrefix = 'hirearchy:r26:drafts:v1:';
const criteriaStoragePrefix = 'hirearchy:r26:criteria:v1:';
const fontSizePrefKey = 'hirearchy:r26:font-size';
const lineWrapPrefKey = 'hirearchy:r26:line-wrap';

function readCsrfCookie(): string {
  if (typeof document === 'undefined') return '';
  for (const part of document.cookie.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === '__Host-r23-csrf' || rawName === 'r23-csrf') {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return rest.join('=');
      }
    }
  }
  return '';
}

function readStoredJson<T>(
  key: string,
  storage: 'session' | 'local',
): T | null {
  try {
    const store =
      storage === 'local' ? window.localStorage : window.sessionStorage;
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeStoredJson(
  key: string,
  value: unknown,
  storage: 'session' | 'local',
): void {
  try {
    const store =
      storage === 'local' ? window.localStorage : window.sessionStorage;
    store.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota / privacy errors
  }
}

function AiCodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    try {
      void navigator.clipboard?.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable in restricted frames
    }
  };

  return (
    <div className="r26-ai-codeblock">
      <div className="r26-ai-codeblock-head">
        <span>{language || 'code'}</span>
        <button type="button" className="r26-pref-btn" onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const tokens = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  return tokens.map((token, index) => {
    if (token.startsWith('`') && token.endsWith('`') && token.length >= 2) {
      return (
        <code key={index} className="r26-ai-inline-code">
          {token.slice(1, -1)}
        </code>
      );
    }
    if (token.startsWith('**') && token.endsWith('**') && token.length >= 4) {
      return <strong key={index}>{token.slice(2, -2)}</strong>;
    }
    return <Fragment key={index}>{token}</Fragment>;
  });
}

function renderTextBlocks(text: string, blockPrefix: string): ReactNode[] {
  const blocks = text
    .replace(/^\n+|\n+$/g, '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map((block, index) => {
    const lines = block.split('\n');
    if (lines.length === 1 && /^#{1,4}\s+/.test(lines[0])) {
      return (
        <h4 key={`${blockPrefix}-h-${index}`} className="r26-ai-md-h">
          {renderInlineMarkdown(lines[0].replace(/^#{1,4}\s+/, ''))}
        </h4>
      );
    }
    if (lines.every((line) => /^[-*]\s+/.test(line.trim()))) {
      return (
        <ul key={`${blockPrefix}-ul-${index}`} className="r26-ai-md-list">
          {lines.map((line, liIndex) => (
            <li key={liIndex}>
              {renderInlineMarkdown(line.trim().replace(/^[-*]\s+/, ''))}
            </li>
          ))}
        </ul>
      );
    }
    if (lines.every((line) => /^\d+\.\s+/.test(line.trim()))) {
      return (
        <ol key={`${blockPrefix}-ol-${index}`} className="r26-ai-md-list">
          {lines.map((line, liIndex) => (
            <li key={liIndex}>
              {renderInlineMarkdown(line.trim().replace(/^\d+\.\s+/, ''))}
            </li>
          ))}
        </ol>
      );
    }
    if (lines.every((line) => /^>\s?/.test(line.trim()))) {
      return (
        <blockquote
          key={`${blockPrefix}-bq-${index}`}
          className="r26-ai-md-quote"
        >
          {renderInlineMarkdown(
            lines.map((line) => line.trim().replace(/^>\s?/, '')).join(' '),
          )}
        </blockquote>
      );
    }
    return (
      <p key={`${blockPrefix}-p-${index}`}>{renderInlineMarkdown(block)}</p>
    );
  });
}

function AiMarkdownContent({ content }: { content: string }) {
  const segments: Array<
    | { kind: 'text'; value: string }
    | { kind: 'code'; language: string; value: string }
  > = [];
  const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        kind: 'text',
        value: content.slice(lastIndex, match.index),
      });
    }
    segments.push({
      kind: 'code',
      language: (match[1] ?? '').trim(),
      value: (match[2] ?? '').replace(/\n$/, ''),
    });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    segments.push({ kind: 'text', value: content.slice(lastIndex) });
  }

  if (segments.length === 0) {
    return <p>{content}</p>;
  }

  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === 'code') {
          return (
            <AiCodeBlock
              key={`code-${index}`}
              language={segment.language}
              code={segment.value}
            />
          );
        }
        return (
          <Fragment key={`text-${index}`}>
            {renderTextBlocks(segment.value, `seg-${index}`)}
          </Fragment>
        );
      })}
    </>
  );
}

export function R26CandidateClient({
  sessionId,
  accountGate,
}: CandidateClientProps) {
  const router = useRouter();
  const activeTheme = useHirearchyTheme();
  const isHiringExperience = Boolean(accountGate);
  const isAccountGateBlocked = Boolean(
    accountGate && accountGate.state !== 'ready',
  );
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<R26CandidateGetResponse | null>(null);
  const viewRef = useRef<R26CandidateGetResponse | null>(null);
  const [acceptedConsent, setAcceptedConsent] = useState<{
    sessionId: string;
    digest: string;
  } | null>(null);
  const [selectedPathState, setSelectedPath] = useState('');
  const [openTabPaths, setOpenTabPaths] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftsByPath, setDraftsByPath] = useState<Record<string, Draft>>({});
  const [checkedCriteria, setCheckedCriteria] = useState<
    Record<number, boolean>
  >({});
  const [pendingSave, setPendingSave] = useState<PendingSave | null>(null);
  const [pendingSubmit, setPendingSubmit] = useState<PendingSubmit | null>(
    null,
  );
  const [conflictLatest, setConflictLatest] =
    useState<R26CandidateFileView | null>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [showExecutionDrawer, setShowExecutionDrawer] =
    useState(!isHiringExperience);
  const [showAiDrawer, setShowAiDrawer] = useState(!isHiringExperience);
  const [mobileTab, setMobileTab] = useState<'code' | 'task' | 'tests' | 'ai'>(
    'task',
  );
  const [isStorageHydrated, setIsStorageHydrated] = useState(false);
  const [aiView, setAiView] = useState<R212CandidateAiView | null>(null);
  const [aiPrompt, setAiPrompt] = useState('');
  const [showEditorCriteria, setShowEditorCriteria] = useState(false);
  const [showTaskPanel, setShowTaskPanel] = useState(true);
  const taskTriggerRef = useRef<HTMLButtonElement>(null);
  const taskHeadingRef = useRef<HTMLHeadingElement>(null);
  const executionTriggerRef = useRef<HTMLButtonElement>(null);
  const submitTriggerRef = useRef<HTMLButtonElement>(null);
  const assistantTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileAssistantRef = useRef<HTMLButtonElement>(null);
  const editorTabsRef = useRef<HTMLElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const setAssistantOpen = useCallback((open: boolean) => {
    setShowAiDrawer(open);
    setMobileTab((current) =>
      open ? 'ai' : current === 'ai' ? 'code' : current,
    );
  }, []);
  const closeAssistant = () => {
    setAssistantOpen(false);
    const mobileTrigger = mobileAssistantRef.current;
    if (mobileTrigger?.getClientRects().length) mobileTrigger.focus();
    else assistantTriggerRef.current?.focus();
  };
  const closeTask = () => {
    setShowTaskPanel(false);
    taskTriggerRef.current?.focus();
  };
  const closeTests = () => {
    setShowExecutionDrawer(false);
    executionTriggerRef.current?.focus();
  };
  const [editorFontSize, setEditorFontSize] = useState<EditorFontSize>(14);
  const [lineWrap, setLineWrap] = useState(true);
  const [submitConfirmOpen, setSubmitConfirmOpen] = useState(false);
  const [pendingAiPrompt, setPendingAiPrompt] = useState<string | null>(null);
  const [toastState, setToastState] = useState<{
    message: string;
    tone: CommonThreadToastTone;
  } | null>(null);
  const [message, setMessage] = useState('');
  const [loadFailure, setLoadFailure] = useState('');
  const [accessUnavailable, setAccessUnavailable] = useState(false);
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [clockNow, setClockNow] = useState(0);
  const refreshInFlight = useRef(false);
  const submitInFlight = useRef(false);
  const reminded10MinRef = useRef(false);
  const reminded2MinRef = useRef(false);
  const consentAccepted = Boolean(
    view?.dataNotice &&
    acceptedConsent?.sessionId === sessionId &&
    acceptedConsent?.digest === view.dataNotice.digest,
  );

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (window.innerWidth > 0 && window.innerWidth < 1280) {
        setShowAiDrawer(false);
      }
      const savedFont = readStoredJson<number>(fontSizePrefKey, 'local');
      if (
        savedFont !== null &&
        (EDITOR_FONT_SIZES as readonly number[]).includes(savedFont)
      ) {
        setEditorFontSize(savedFont as EditorFontSize);
      }
      const savedWrap = readStoredJson<boolean>(lineWrapPrefKey, 'local');
      if (typeof savedWrap === 'boolean') {
        setLineWrap(savedWrap);
      }
      const savedDrafts =
        readStoredJson<Record<string, Draft>>(
          `${draftsStoragePrefix}${sessionId}`,
          'local',
        ) ??
        readStoredJson<Record<string, Draft>>(
          `${draftsStoragePrefix}${sessionId}`,
          'session',
        );
      if (savedDrafts && typeof savedDrafts === 'object') {
        setDraftsByPath(savedDrafts);
      }
      const savedCriteria =
        readStoredJson<Record<number, boolean>>(
          `${criteriaStoragePrefix}${sessionId}`,
          'local',
        ) ??
        readStoredJson<Record<number, boolean>>(
          `${criteriaStoragePrefix}${sessionId}`,
          'session',
        );
      if (savedCriteria && typeof savedCriteria === 'object') {
        setCheckedCriteria(savedCriteria);
      }
      const savedWorkspaceUi =
        readStoredJson<{
          selectedPath?: string;
          openTabPaths?: string[];
          aiPrompt?: string;
        }>(`hirearchy:r26:workspace-ui:v1:${sessionId}`, 'local') ??
        readStoredJson<{
          selectedPath?: string;
          openTabPaths?: string[];
          aiPrompt?: string;
        }>(`hirearchy:r26:workspace-ui:v1:${sessionId}`, 'session');
      if (savedWorkspaceUi && typeof savedWorkspaceUi === 'object') {
        if (typeof savedWorkspaceUi.selectedPath === 'string') {
          setSelectedPath(savedWorkspaceUi.selectedPath);
        }
        if (Array.isArray(savedWorkspaceUi.openTabPaths)) {
          setOpenTabPaths(
            savedWorkspaceUi.openTabPaths.filter(
              (item): item is string => typeof item === 'string',
            ),
          );
        }
        if (typeof savedWorkspaceUi.aiPrompt === 'string') {
          setAiPrompt(savedWorkspaceUi.aiPrompt);
        }
      }
      setIsStorageHydrated(true);
    });
    return () => {
      active = false;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!isStorageHydrated) return;
    writeStoredJson(fontSizePrefKey, editorFontSize, 'local');
  }, [editorFontSize, isStorageHydrated]);

  useEffect(() => {
    if (!isStorageHydrated) return;
    writeStoredJson(lineWrapPrefKey, lineWrap, 'local');
  }, [lineWrap, isStorageHydrated]);

  useEffect(() => {
    if (!isStorageHydrated) return;
    writeStoredJson(
      `${draftsStoragePrefix}${sessionId}`,
      draftsByPath,
      'local',
    );
    writeStoredJson(
      `${draftsStoragePrefix}${sessionId}`,
      draftsByPath,
      'session',
    );
  }, [draftsByPath, sessionId, isStorageHydrated]);

  useEffect(() => {
    if (!isStorageHydrated) return;
    writeStoredJson(
      `${criteriaStoragePrefix}${sessionId}`,
      checkedCriteria,
      'local',
    );
    writeStoredJson(
      `${criteriaStoragePrefix}${sessionId}`,
      checkedCriteria,
      'session',
    );
  }, [checkedCriteria, sessionId, isStorageHydrated]);

  useEffect(() => {
    if (!isStorageHydrated) return;
    const payload = {
      selectedPath: selectedPathState,
      openTabPaths,
      aiPrompt,
    };
    writeStoredJson(
      `hirearchy:r26:workspace-ui:v1:${sessionId}`,
      payload,
      'local',
    );
    writeStoredJson(
      `hirearchy:r26:workspace-ui:v1:${sessionId}`,
      payload,
      'session',
    );
  }, [aiPrompt, isStorageHydrated, openTabPaths, selectedPathState, sessionId]);
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
            credentials: 'same-origin',
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
      setPendingAiPrompt(prompt);

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
            credentials: 'same-origin',
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
        setPendingAiPrompt(null);
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
    async (
      capabilityEnabled = viewRef.current?.capabilities.execution,
      silent = false,
    ) => {
      if (!token || capabilityEnabled !== true) return;
      if (!silent) setExecutionViewLoading(true);
      try {
        const response = await fetch(
          `/r26/api/candidate/${encodeURIComponent(sessionId)}/execution`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${token}`,
            },
            cache: 'no-store',
            credentials: 'same-origin',
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
        if (!silent) setExecutionViewLoading(false);
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
          credentials: 'same-origin',
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
        const rawFragmentToken = fragment.startsWith('token=')
          ? new URLSearchParams(fragment).get('token')
          : decodeURIComponent(fragment);
        if (isValidToken(rawFragmentToken)) fragmentToken = rawFragmentToken;
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
    if (isAccountGateBlocked) {
      let active = true;
      queueMicrotask(() => {
        if (active) setLoading(false);
      });
      return () => {
        active = false;
      };
    }
    if (token === undefined) return;
    if (!token) {
      let active = true;
      if (isHiringExperience && accountGate?.state === 'ready') {
        void fetch('/api/candidate-portal', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'launch_session',
            csrf: readCsrfCookie(),
            sessionId,
          }),
        })
          .then(async (res) => {
            if (!res.ok) return null;
            return (await res.json()) as { launchUrl?: string } | null;
          })
          .then((data) => {
            if (!active) return;
            const hashPart = data?.launchUrl?.split('#')[1] ?? '';
            const recoveredToken = hashPart
              ? decodeURIComponent(
                  hashPart.startsWith('token=')
                    ? (new URLSearchParams(hashPart).get('token') ?? '')
                    : hashPart,
                )
              : null;
            if (isValidToken(recoveredToken)) {
              try {
                window.sessionStorage.setItem(
                  `${tokenStoragePrefix}${sessionId}`,
                  recoveredToken,
                );
              } catch {
                // Ignore storage errors
              }
              setToken(recoveredToken);
              return;
            }
            setLoadFailure(
              'This link is missing or invalid. Open this assessment from My assessments.',
            );
            setLoading(false);
          })
          .catch(() => {
            if (!active) return;
            setLoadFailure(
              'Could not restore your assessment session. Open it from My assessments.',
            );
            setLoading(false);
          });
        return () => {
          active = false;
        };
      }
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
  }, [
    accountGate?.state,
    applyView,
    callApi,
    fetchAiView,
    fetchExecutionView,
    isAccountGateBlocked,
    isHiringExperience,
    sessionId,
    token,
  ]);

  const draftPath = draft?.path;
  const refresh = useCallback(
    async (silent = false) => {
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
        void fetchExecutionView(next.capabilities.execution, silent);
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
        if (!silent) {
          setMessage(
            'The latest saved state could not be refreshed. Your current editor content is still here.',
          );
        }
      } finally {
        refreshInFlight.current = false;
      }
    },
    [
      accessUnavailable,
      applyView,
      callApi,
      draftPath,
      fetchAiView,
      fetchExecutionView,
      saveConflict,
      token,
    ],
  );

  useEffect(() => {
    const intervalMs = executionRunning || aiSubmitting ? 2_000 : 5_000;
    const interval = window.setInterval(() => {
      setClockNow(Date.now());
      if (
        typeof document !== 'undefined' &&
        !document.hidden &&
        viewRef.current?.status === 'ACTIVE'
      ) {
        void refresh(true);
      }
    }, intervalMs);
    const clock = window.setInterval(() => setClockNow(Date.now()), 1000);
    const handleVisibility = () => {
      if (!document.hidden && viewRef.current?.status === 'ACTIVE') {
        setClockNow(Date.now());
        void refresh(true);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(interval);
      window.clearInterval(clock);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [aiSubmitting, executionRunning, refresh]);

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
    const storedForPath = draftsByPath[selectedPath];
    if (
      storedForPath &&
      (storedForPath.content !== storedForPath.baseContent ||
        storedForPath.baseVersion === activeFile.version)
    ) {
      return storedForPath;
    }
    return makeDraft(activeFile);
  }, [activeFile, draft, draftsByPath, selectedPath, view?.status]);
  const isDirty = Boolean(
    currentDraft && currentDraft.content !== currentDraft.baseContent,
  );
  const scenario = view?.scenario ?? {};
  const scenarioTitle = scenarioText(scenario, 'title') || 'Assessment task';
  const brief = scenarioText(scenario, 'brief');
  const criteria = scenarioList(scenario, 'acceptanceCriteria');
  const checkedCriteriaCount = criteria.filter(
    (_, index) => checkedCriteria[index],
  ).length;
  const taskChecklist =
    criteria.length > 0 ? (
      <details className="r26-criteria r26-task-goal-card" open>
        <summary>
          <IconChevronRight size={16} aria-hidden="true" />
          <span>Acceptance criteria</span>
          <span className="r26-criteria-progress">
            {checkedCriteriaCount} of {criteria.length} checked
          </span>
        </summary>
        <ul className="r26-criteria-checklist">
          {criteria.map((criterion, index) => {
            const isChecked = Boolean(checkedCriteria[index]);
            return (
              <li key={`${index}-${criterion}`}>
                <label
                  className={`r26-criteria-check-label ${isChecked ? 'is-checked' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={(event) =>
                      setCheckedCriteria((current) => ({
                        ...current,
                        [index]: event.target.checked,
                      }))
                    }
                  />
                  <span>{criterion}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </details>
    ) : null;
  const briefWorkspaceContext = useMemo(
    () => ({
      filePaths: view?.files.map((file) => file.path),
      testsRunnable: view?.capabilities.execution,
      integratedAiEnabled: view?.capabilities.ai,
    }),
    [view?.files, view?.capabilities.execution, view?.capabilities.ai],
  );
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
  const activeWorkspace = isHiringExperience && view?.status === 'ACTIVE';
  const prestart = isHiringExperience && view?.status === 'CREATED';
  const focusTaskOnStart = useRef(false);
  useEffect(() => {
    if (!activeWorkspace || !focusTaskOnStart.current) return;
    focusTaskOnStart.current = false;
    taskHeadingRef.current?.focus();
  }, [activeWorkspace]);
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
  const isSyntheticAiLane =
    !isHiringExperience &&
    (!aiView?.providerId || aiView.providerId.includes('synthetic'));

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
      focusTaskOnStart.current = isHiringExperience && next.status === 'ACTIVE';
      applyView(next);
      setMobileTab('task');
      if (!isHiringExperience)
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
    async (intent: PendingSave, automatic = false): Promise<boolean> => {
      setBusy(true);
      setMessage('');
      try {
        const next = await callApi('POST', { action: 'save', input: intent });
        const saved = next.files.find((file) => file.path === intent.path);
        applyView(next);
        if (saved) {
          if (saved.content === intent.content) {
            const nextSavedDraft: Draft = {
              path: saved.path,
              content: saved.content,
              baseContent: saved.content,
              baseVersion: saved.version,
              baseDigest: saved.digest,
            };
            const rebaseDraft = (localDraft: Draft | null | undefined) =>
              localDraft?.path === intent.path &&
              localDraft.content !== intent.content
                ? { ...nextSavedDraft, content: localDraft.content }
                : nextSavedDraft;
            setDraft((current) =>
              current?.path === intent.path ? rebaseDraft(current) : current,
            );
            setDraftsByPath((current) => ({
              ...current,
              [intent.path]: rebaseDraft(current[intent.path]),
            }));
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
          return false;
        }
        setPendingSave(null);
        if (saved?.content === intent.content) {
          setConflictLatest(null);
          if (!automatic && !isHiringExperience) {
            setMessage('Work saved.');
          }
          return true;
        } else if (saved) {
          setMessage(
            'Your save was accepted, and a newer saved version now exists. Your draft is preserved; resolve the version conflict before saving again.',
          );
          return false;
        }
        return false;
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
        return false;
      } finally {
        setBusy(false);
      }
    },
    [applyView, callApi, isHiringExperience],
  );

  const save = useCallback(
    async (automatic = false): Promise<boolean> => {
      if (saveConflict || conflictLatest) return false;
      if (pendingSave) {
        if (busy || pendingSubmit || !canEdit || !activeFile) return false;
        return retrySave(pendingSave, automatic);
      }
      if (!currentDraft || !isDirty) return true;
      if (!canEdit || pendingSubmit || busy || !activeFile) return false;
      const intent: PendingSave = {
        requestId: requestId(),
        path: currentDraft.path,
        content: currentDraft.content,
        expectedVersion: currentDraft.baseVersion,
      };
      setPendingSave(intent);
      return retrySave(intent, automatic);
    },
    [
      activeFile,
      busy,
      canEdit,
      conflictLatest,
      currentDraft,
      isDirty,
      pendingSave,
      pendingSubmit,
      retrySave,
      saveConflict,
    ],
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
    !pendingSave &&
    !saveConflict &&
    !executionRunning,
  );

  const runChecks = useCallback(async () => {
    if (!canRunChecks || !token || !view) return;
    if (isDirty) {
      const savedOk = await save(false);
      if (!savedOk) return;
    }

    const activeView = viewRef.current ?? view;
    const workspaceDigest = activeView.workspaceDigest;
    setExecutionRunning(true);
    setExecutionError(null);

    // Retries use consistent request identity; changed files update expected digest
    if (lastExecutedDigestRef.current !== workspaceDigest) {
      executionRequestIdRef.current = requestId();
      lastExecutedDigestRef.current = workspaceDigest;
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
            expectedWorkspaceDigest: workspaceDigest,
          }),
          cache: 'no-store',
          credentials: 'same-origin',
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

      setToastState({ message: 'Test run finished.', tone: 'success' });
      executionRequestIdRef.current = requestId();
    } catch {
      setExecutionError('Network error executing checks. Please retry.');
    } finally {
      setExecutionRunning(false);
    }
  }, [canRunChecks, fetchExecutionView, isDirty, save, sessionId, token, view]);

  useEffect(() => {
    const handleShortcuts = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        if (canEdit) void save(false);
        return;
      }
      if (
        key === 'enter' &&
        (document.activeElement as HTMLElement | null)?.id !==
          'r26-ai-prompt-input'
      ) {
        if (canRunChecks) {
          event.preventDefault();
          setShowExecutionDrawer(true);
          void runChecks();
        }
        return;
      }
      if (
        key === 'j' &&
        viewRef.current?.capabilities.ai &&
        viewRef.current?.status !== 'CREATED'
      ) {
        event.preventDefault();
        setAssistantOpen(!showAiDrawer);
      }
    };
    window.addEventListener('keydown', handleShortcuts);
    return () => window.removeEventListener('keydown', handleShortcuts);
  }, [canEdit, canRunChecks, runChecks, save, setAssistantOpen, showAiDrawer]);

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
      setSubmitConfirmOpen(false);

      if (
        activeWorkspace &&
        next.status === 'SUBMITTED' &&
        next.closureReason !== 'timeout' &&
        !Object.values(draftsByPath).some(
          (localDraft) => localDraft.content !== localDraft.baseContent,
        )
      ) {
        router.replace(
          `/candidate/submissions/${encodeURIComponent(sessionId)}`,
        );
        return;
      }

      setMessage('Assessment submitted. Your saved work is now read-only.');
      void fetchAiView(next.capabilities.ai);
      void fetchExecutionView(next.capabilities.execution);
    } catch (error) {
      if (activeWorkspace) {
        setSubmitConfirmOpen(false);
        requestAnimationFrame(() => submitTriggerRef.current?.focus());
      }
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

  const showEditor = Boolean(
    view && !prestart && (view.status !== 'CREATED' || view.files.length > 0),
  );
  const saveStatus =
    accessUnavailable || sessionTimeExpired || invitationExpired
      ? isDirty || pendingSave
        ? 'Access ended · Draft may be unsaved'
        : 'Access ended · Saved work is read-only'
      : pendingSubmit
        ? busy
          ? 'Confirming submission…'
          : 'Submission unconfirmed'
        : saveConflict
          ? 'Save conflict · Draft preserved'
          : pendingSave && !busy
            ? 'Save unconfirmed'
            : pendingSave || isDirty
              ? 'Saving…'
              : 'All changes saved';
  const fileTree = useMemo(
    () => buildFileTree(view?.files ?? []),
    [view?.files],
  );
  useEffect(() => {
    const tabs = editorTabsRef.current;
    const activeTab = tabs?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!tabs || !activeTab) return;
    const viewport = tabs.getBoundingClientRect();
    const active =
      activeTab.parentElement?.getBoundingClientRect() ??
      activeTab.getBoundingClientRect();
    if (active.left < viewport.left)
      tabs.scrollLeft += active.left - viewport.left;
    else if (active.right > viewport.right)
      tabs.scrollLeft += active.right - viewport.right;
  }, [selectedPath]);

  const resolvedOpenTabPaths = useMemo(() => {
    if (!view || view.files.length === 0) return [];
    const existingSet = new Set(view.files.map((file) => file.path));
    const ordered = openTabPaths.filter((path) => existingSet.has(path));
    if (ordered.length === 0) {
      return isHiringExperience
        ? [selectedPath || view.files[0].path]
        : view.files.map((file) => file.path);
    }
    if (
      selectedPath &&
      existingSet.has(selectedPath) &&
      !ordered.includes(selectedPath)
    ) {
      return [...ordered, selectedPath];
    }
    return ordered;
  }, [isHiringExperience, openTabPaths, selectedPath, view]);

  const canSwitchFile = Boolean(
    !busy && !pendingSubmit && !saveConflict && !conflictLatest,
  );
  const selectWorkspaceFile = async (nextPath: string) => {
    if (!canSwitchFile) return;
    if (nextPath === selectedPath) {
      setMobileTab('code');
      return;
    }
    if (currentDraft) {
      setDraftsByPath((current) => ({
        ...current,
        [selectedPath]: currentDraft,
      }));
    }
    if (pendingSave || isDirty) {
      if (!(await save(false))) return;
    }
    setOpenTabPaths((current) => {
      const base =
        current.length > 0
          ? current
          : isHiringExperience
            ? [selectedPath].filter(Boolean)
            : (view?.files ?? []).map((file) => file.path);
      return base.includes(nextPath) ? base : [...base, nextPath];
    });
    const nextFile = view?.files.find((file) => file.path === nextPath);
    const cachedDraft = draftsByPath[nextPath];
    if (
      cachedDraft &&
      nextFile &&
      (cachedDraft.content !== cachedDraft.baseContent ||
        cachedDraft.baseVersion === nextFile.version)
    ) {
      setDraft(cachedDraft);
    } else if (nextFile) {
      setDraft(makeDraft(nextFile));
    }
    setSelectedPath(nextPath);
    setMobileTab('code');
    setConflictLatest(null);
    setMessage('');
  };
  const closeWorkspaceTab = (tabPath: string) => {
    if (resolvedOpenTabPaths.length <= 1) return;
    const remaining = resolvedOpenTabPaths.filter((p) => p !== tabPath);
    setOpenTabPaths(remaining);
    if (tabPath === selectedPath && remaining.length > 0) {
      void selectWorkspaceFile(remaining[0]);
    }
  };
  const toggleFolder = (folderPath: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  };
  const openSectionDisclosure = (targetId: string) => {
    const details = document.getElementById(targetId)?.closest('details');
    if (details) details.open = true;
  };
  const activatedAtMs = timestampMilliseconds(view?.activatedAt);
  const totalWindowMs =
    view?.durationSeconds && view.durationSeconds > 0
      ? view.durationSeconds * 1000
      : activeAccessEndsAtMs !== null &&
          activatedAtMs !== null &&
          activeAccessEndsAtMs > activatedAtMs
        ? activeAccessEndsAtMs - activatedAtMs
        : null;
  const remainingPercent =
    remainingMs !== null && totalWindowMs && totalWindowMs > 0
      ? Math.max(0, Math.min(100, (remainingMs / totalWindowMs) * 100))
      : null;
  const timerLow = isHiringExperience
    ? remainingMs !== null && remainingMs <= 5 * 60_000
    : remainingPercent !== null && remainingPercent <= 20;

  useEffect(() => {
    if (view?.status !== 'ACTIVE' || remainingMs === null || remainingMs <= 0) {
      return;
    }
    if (remainingMs <= 2 * 60_000 && !reminded2MinRef.current) {
      reminded2MinRef.current = true;
      reminded10MinRef.current = true;
      setToastState({
        message: '2 minutes remaining — wrap up and submit when ready.',
        tone: 'warning',
      });
      return;
    }
    if (remainingMs <= 10 * 60_000 && !reminded10MinRef.current) {
      reminded10MinRef.current = true;
      setToastState({
        message: '10 minutes remaining — changes save automatically.',
        tone: 'info',
      });
    }
  }, [remainingMs, view?.status]);

  const renderTreeNodes = (nodes: readonly FileTreeNode[], depth = 0) =>
    nodes.map((node) => {
      if (node.kind === 'folder') {
        const isOpen = !collapsedFolders.has(node.path);
        return (
          <li className="r26-tree-folder" key={`folder:${node.path}`}>
            <button
              type="button"
              className="r26-tree-folder-btn"
              style={{ paddingLeft: `${10 + depth * 12}px` }}
              aria-expanded={isOpen}
              onClick={() => toggleFolder(node.path)}
            >
              <IconChevronRight
                size={13}
                stroke={2}
                className={`r26-tree-chevron ${isOpen ? 'is-open' : ''}`}
                aria-hidden="true"
              />
              {isOpen ? (
                <IconFolderOpen size={15} stroke={1.8} aria-hidden="true" />
              ) : (
                <IconFolder size={15} stroke={1.8} aria-hidden="true" />
              )}
              <span>{node.name}</span>
            </button>
            {isOpen ? (
              <ul className="r26-tree-list">
                {renderTreeNodes(node.children, depth + 1)}
              </ul>
            ) : null}
          </li>
        );
      }

      const isSelected = node.path === selectedPath;
      return (
        <li className="r26-tree-file" key={`file:${node.path}`}>
          <button
            type="button"
            className={`r26-tree-file-btn ${isSelected ? 'is-active' : ''}`}
            style={{ paddingLeft: `${26 + depth * 12}px` }}
            aria-current={isSelected ? 'page' : undefined}
            disabled={!canSwitchFile && !isSelected}
            title={
              !canSwitchFile && !isSelected
                ? 'Resolve pending workspace action before switching files'
                : node.path
            }
            onClick={() => void selectWorkspaceFile(node.path)}
          >
            <IconFileCode size={15} stroke={1.8} aria-hidden="true" />
            <span className="r26-tree-file-name">{node.name}</span>
            {isSelected && isDirty ? (
              <span
                className="r26-tree-dirty-dot"
                title="Unsaved edits"
                aria-hidden="true"
              />
            ) : null}
          </button>
        </li>
      );
    });

  const renderCapabilitiesDisclosure = (placement: 'prestart' | 'footer') =>
    view ? (
      <details
        className={`r26-disclosure r26-availability ${placement === 'footer' ? 'r26-footer-capabilities' : ''}`}
      >
        <summary>Workspace capabilities</summary>
        <div className="r26-capabilities-body">
          <ul>
            <li>
              <span>Code editing</span>
              <strong>Available</strong>
            </li>
            <li>
              <span>{isHiringExperience ? 'Tests' : 'Terminal'}</span>
              {view.capabilities.execution && executionView?.terminalEnabled ? (
                <div className="r26-capability-detail">
                  <strong data-testid="terminal-capability-status">
                    {isHiringExperience
                      ? 'Available'
                      : 'Available (Synthetic Test Lane)'}
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
                      {isHiringExperience
                        ? 'Automated tests are not enabled for this assessment.'
                        : 'Code execution is unavailable for this assessment.'}
                    </span>
                  ) : null}
                </div>
              )}
            </li>
            <li>
              <span>AI assistance</span>
              {view.capabilities.ai && aiView?.enabled ? (
                <div className="r26-capability-detail">
                  <strong>
                    {isSyntheticAiLane
                      ? 'Available (Synthetic Test Lane)'
                      : 'Available'}
                  </strong>
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
                    {view.capabilities.ai || isHiringExperience
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
                  ? isHiringExperience
                    ? 'Not enabled'
                    : 'Unavailable in this demo'
                  : latestExecution
                    ? isHiringExperience
                      ? latestExecution.exitCode === 0
                        ? 'Passed'
                        : `Completed (${latestExecution.status.toLowerCase()})`
                      : `Executed (${latestExecution.status})`
                    : isHiringExperience
                      ? 'No runs yet'
                      : 'Not run'}
              </strong>
            </li>
          </ul>
          <p>
            {isHiringExperience
              ? 'Saved files and your final submission are shared with the hiring team for review.'
              : 'This workspace records saved code changes and final submission for your assigned hiring team’s review.'}
          </p>
        </div>
      </details>
    ) : null;

  if (isAccountGateBlocked && accountGate) {
    const returnUrl = `/r26/candidate/${encodeURIComponent(sessionId)}`;
    return (
      <div className="hiring-gate-shell software-product">
        <div className="hiring-gate-card">
          <div className="hiring-gate-topbar">
            <span className="software-document-wordmark">
              <span>Hirearchy</span>
              <span className="software-document-product">Software</span>
            </span>
            <div className="software-header-controls">
              <ThemeToggle variant="pill" />
            </div>
          </div>
          {accountGate.state === 'sign_in_required' ? (
            <>
              <h1>Sign in to start your assessment</h1>
              <p className="hiring-gate-note">
                Sign in or create a Hirearchy Software candidate account using
                the email address invited to this assessment. Your assessment
                link stays preserved automatically.
              </p>
              <div className="hiring-gate-actions">
                <a
                  className="hiring-btn hiring-btn-primary"
                  href={`/candidate/login?next=${encodeURIComponent(returnUrl)}`}
                >
                  Sign in
                </a>
                <a
                  className="hiring-btn"
                  href={`/candidate/signup?next=${encodeURIComponent(returnUrl)}`}
                >
                  Create account
                </a>
              </div>
            </>
          ) : accountGate.state === 'profile_required' ? (
            <>
              <h1>Complete your candidate profile</h1>
              <p className="hiring-gate-note">
                Signed in as <strong>{accountGate.signedInEmail}</strong>. Add
                your name to finish setting up your candidate profile.
              </p>
              <div className="hiring-gate-actions">
                <a
                  className="hiring-btn hiring-btn-primary"
                  href={`/candidate?setup=1&next=${encodeURIComponent(returnUrl)}`}
                >
                  Complete profile
                </a>
              </div>
            </>
          ) : accountGate.state === 'unavailable' ? (
            <>
              <h1>Assessment unavailable</h1>
              <p className="hiring-gate-note">
                Open an active invitation from your assessments.
              </p>
              <div className="hiring-gate-actions">
                <a className="hiring-btn hiring-btn-primary" href="/candidate">
                  My assessments
                </a>
              </div>
            </>
          ) : (
            <>
              <h1>Use the email from your invitation</h1>
              <p className="hiring-gate-note">
                You are signed in as{' '}
                <strong>{accountGate.signedInEmail}</strong>. Switch to the
                account that received this invitation.
              </p>
              <div className="hiring-gate-actions">
                <button
                  type="button"
                  className="hiring-btn hiring-btn-primary"
                  onClick={() => {
                    void fetch('/api/candidate-portal', {
                      method: 'POST',
                      credentials: 'same-origin',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'logout' }),
                    }).finally(() => {
                      window.location.assign(
                        `/candidate/login?next=${encodeURIComponent(returnUrl)}`,
                      );
                    });
                  }}
                >
                  Switch account
                </button>
                <a className="hiring-btn" href="/candidate">
                  My assessments
                </a>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <main
      className="r26-candidate software-product"
      data-active-workspace={activeWorkspace || undefined}
      data-candidate-loading={loading || undefined}
    >
      <header className="r26-header">
        <div className="r26-brand">
          <strong>Hirearchy</strong>
          <span className="r26-product-tab">Software</span>
          {!prestart ? (
            <span className="r26-workspace-label">
              {view && view.status !== 'CREATED'
                ? scenarioTitle
                : 'Candidate workspace'}
            </span>
          ) : null}
        </div>
        <div className="r26-header-status">
          <ThemeToggle variant="header" />
          {view?.status === 'ACTIVE' && remainingMs !== null ? (
            <div
              className={`r26-timer ${timerLow ? 'is-low' : ''}`}
              role="timer"
              aria-label="Time remaining"
              title={`Access ends no later than ${formatDateTime(activeAccessEndsAtMs)}`}
            >
              <div className="r26-timer-row">
                <IconClock size={14} stroke={2} aria-hidden="true" />
                <span className="r26-timer-label" aria-hidden="true">
                  Time left
                </span>
                <strong>{formatDuration(remainingMs)}</strong>
              </div>
              {remainingPercent !== null ? (
                <div className="r26-timer-track" aria-hidden="true">
                  <div
                    className="r26-timer-fill"
                    style={{ width: `${remainingPercent}%` }}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
          {activeWorkspace ? (
            <button
              type="button"
              ref={taskTriggerRef}
              className={`r26-header-tool ${showTaskPanel && !showAiDrawer ? 'is-active' : ''}`}
              aria-expanded={showTaskPanel && !showAiDrawer}
              aria-controls="candidate-task-brief"
              onClick={() => {
                if (showAiDrawer) {
                  setAssistantOpen(false);
                  setShowTaskPanel(true);
                } else setShowTaskPanel((open) => !open);
              }}
            >
              <IconLayoutSidebarRight
                size={15}
                stroke={1.9}
                aria-hidden="true"
              />
              <span>Task</span>
            </button>
          ) : null}
          {view && view.status !== 'CREATED' && view.capabilities.execution ? (
            <button
              type="button"
              ref={executionTriggerRef}
              className={`r26-header-tool ${showExecutionDrawer ? 'is-active' : ''}`}
              aria-expanded={showExecutionDrawer}
              aria-controls="candidate-execution-panel"
              onClick={() => setShowExecutionDrawer((current) => !current)}
            >
              <IconTerminal2 size={15} stroke={1.9} aria-hidden="true" />
              <span>{isHiringExperience ? 'Tests' : 'Terminal'}</span>
            </button>
          ) : null}
          {view && view.status !== 'CREATED' && view.capabilities.ai ? (
            <button
              type="button"
              ref={assistantTriggerRef}
              className={`r26-header-tool ${showAiDrawer ? 'is-active' : ''}`}
              aria-expanded={showAiDrawer}
              aria-controls="candidate-assistant-panel"
              onClick={() => setAssistantOpen(!showAiDrawer)}
            >
              <IconMessageCode size={15} stroke={1.9} aria-hidden="true" />
              <span>Assistant</span>
            </button>
          ) : null}
          {view &&
          !prestart &&
          (view.status !== 'ACTIVE' ||
            remainingMs === null ||
            accessUnavailable ||
            invitationExpired ||
            sessionTimeExpired) ? (
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
          {showEditor && (canEdit || pendingSubmit) ? (
            <button
              ref={submitTriggerRef}
              className={`r26-button ${
                isHiringExperience && !pendingSubmit
                  ? 'r26-button-secondary r26-submit-quiet'
                  : 'r26-button-primary'
              } r26-header-submit`}
              disabled={
                busy ||
                (!pendingSubmit &&
                  (isDirty || Boolean(pendingSave) || saveConflict))
              }
              aria-label={!pendingSubmit ? 'Submit assessment' : undefined}
              aria-describedby={
                pendingSave || saveConflict
                  ? 'candidate-submit-save-status'
                  : undefined
              }
              title={
                isDirty
                  ? 'Waiting for latest edits to save automatically before submission'
                  : undefined
              }
              onClick={() => {
                if (isHiringExperience && !pendingSubmit) {
                  setSubmitConfirmOpen(true);
                } else {
                  void submit();
                }
              }}
              type="button"
            >
              {busy && pendingSubmit ? (
                <>
                  <IconLoader2
                    className="r26-action-spinner"
                    size={16}
                    aria-hidden="true"
                  />
                  Submitting…
                </>
              ) : pendingSubmit ? (
                'Retry submission'
              ) : isHiringExperience ? (
                'Submit'
              ) : (
                'Submit assessment'
              )}
            </button>
          ) : null}
        </div>
      </header>

      {view && showEditor ? (
        <nav className="r26-mobile-navigation" aria-label="Workspace sections">
          <button
            type="button"
            aria-pressed={mobileTab === 'code'}
            onClick={() => setMobileTab('code')}
          >
            Code
          </button>
          <button
            type="button"
            aria-pressed={mobileTab === 'task'}
            onClick={() => {
              setMobileTab('task');
              openSectionDisclosure('candidate-brief-content');
            }}
          >
            Task
          </button>
          {view.status !== 'CREATED' && view.capabilities.execution ? (
            <button
              type="button"
              aria-pressed={mobileTab === 'tests'}
              onClick={() => {
                setShowExecutionDrawer(true);
                setMobileTab('tests');
              }}
            >
              Tests
            </button>
          ) : null}
          {view.status !== 'CREATED' && view.capabilities.ai ? (
            <button
              type="button"
              ref={mobileAssistantRef}
              aria-pressed={mobileTab === 'ai'}
              onClick={() => setAssistantOpen(true)}
            >
              Assistant
            </button>
          ) : null}
        </nav>
      ) : null}

      {isHiringExperience && view && submitted ? (
        <section
          className="r26-submission-receipt-top"
          aria-label="Submission confirmation"
          role="status"
        >
          <div className="r26-submission-receipt-copy">
            <span className="hiring-pill hiring-pill-success">Submitted</span>
            <h2>
              {view.closureReason === 'timeout'
                ? 'Closed when time ended'
                : 'Assessment submitted'}
            </h2>
            <p>
              {view.submittedAt ? (
                <>
                  Submitted{' '}
                  <time dateTime={view.submittedAt}>
                    {formatLocalDateTime(view.submittedAt)}
                  </time>
                  .{' '}
                </>
              ) : null}
              Captured {view.files.length} saved workspace file
              {view.files.length === 1 ? '' : 's'}
              {view.capabilities.execution
                ? executionView?.operations.length
                  ? ` and ${executionView.operations.length} recorded test run${executionView.operations.length === 1 ? '' : 's'}`
                  : ' and execution records'
                : ' (test runner disabled for this assessment)'}
              {view.capabilities.ai ? ' and AI conversation records' : ''}. Your
              code below is now read-only.
            </p>
            {isHiringExperience ? (
              <p>
                Your hiring team can now review your submission. Any feedback
                they share will appear in My assessments.
              </p>
            ) : null}
          </div>
          <div className="r26-submission-receipt-actions">
            <a
              className="r26-button r26-button-primary"
              href={`/candidate/submissions/${encodeURIComponent(sessionId)}`}
            >
              View submitted work
            </a>
            <a className="r26-button r26-button-secondary" href="/candidate">
              Return to My assessments
            </a>
          </div>
        </section>
      ) : null}

      <div
        className="r26-workspace"
        data-session-state={view?.status.toLowerCase() ?? 'loading'}
        data-prestart-stage={prestart}
        data-task-open={showTaskPanel}
        data-ai-enabled={
          view?.capabilities.ai === true &&
          showAiDrawer &&
          !(isHiringExperience && view?.status === 'CREATED')
            ? 'true'
            : 'false'
        }
        data-mobile-tab={mobileTab}
      >
        {activeWorkspace ? (
          <aside className="r26-desktop-files" aria-label="Workspace files">
            <h2>Files</h2>
            {view.files.length ? (
              <ul className="r26-tree-list r26-tree-root">
                {renderTreeNodes(fileTree)}
              </ul>
            ) : (
              <p>No workspace files are available.</p>
            )}
          </aside>
        ) : null}
        <aside
          id="candidate-task-brief"
          className="r26-task-panel"
          aria-label="Assessment task"
          tabIndex={0}
          onKeyDown={(event) => {
            if (
              activeWorkspace &&
              event.key === 'Escape' &&
              !event.defaultPrevented &&
              taskTriggerRef.current?.getClientRects().length
            ) {
              event.preventDefault();
              closeTask();
            }
          }}
        >
          {loading ? (
            <div style={{ padding: '1rem 0.25rem' }}>
              <CommonThreadLoader compact label="Loading workspace…" />
            </div>
          ) : null}
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
              {submitted && !isHiringExperience ? (
                <div className="r26-notice r26-notice-success" role="status">
                  <strong>Assessment submitted</strong>
                  <p>
                    {view.closureReason === 'timeout'
                      ? 'The assessment closed when its time limit ended.'
                      : 'Your saved work has been submitted and is read-only.'}
                  </p>
                  {view.submission ? (
                    <details className="r26-disclosure">
                      <summary>Submission receipt</summary>
                      <p>
                        Workspace digest{' '}
                        <code>{view.submission.workspaceDigest}</code>
                      </p>
                    </details>
                  ) : null}
                </div>
              ) : null}

              {prestart ? (
                <section
                  className="r26-prestart-stage"
                  aria-labelledby="candidate-readiness-title"
                >
                  <nav className="r26-breadcrumb" aria-label="Breadcrumb">
                    <a href="/candidate">My assessments</a>
                    <span aria-hidden="true">/</span>
                    <span aria-current="page">{scenarioTitle}</span>
                  </nav>
                  <h1 id="candidate-readiness-title">{scenarioTitle}</h1>
                  <div className="r26-readiness-overview">
                    <div className="r26-readiness-instructions">
                      <section aria-labelledby="candidate-before-start">
                        <h2 id="candidate-before-start">Before you start</h2>
                        <p id="candidate-start-timing">
                          <IconClock size={25} aria-hidden="true" />
                          <span>
                            {view.durationSeconds
                              ? `Your ${Math.round(view.durationSeconds / 60)}-minute timer starts once the workspace is ready.`
                              : 'Select Start assessment to open the task and files.'}
                          </span>
                        </p>
                      </section>
                      {view.dataNotice ? (
                        <section
                          aria-labelledby="candidate-data-use-title"
                          data-testid="candidate-data-use-notice"
                        >
                          <h2 id="candidate-data-use-title">What’s recorded</h2>
                          <p id="candidate-data-use-summary">
                            <IconFile size={24} aria-hidden="true" />
                            <span>
                              Your saved files and revisions, task activity,
                              {view.capabilities.execution ? ' test runs,' : ''}
                              {view.capabilities.ai
                                ? ' AI conversations,'
                                : ''}{' '}
                              and final submission are recorded for the hiring
                              team.
                            </span>
                          </p>
                        </section>
                      ) : null}
                    </div>
                    <section
                      className="r26-readiness-tools"
                      aria-labelledby="candidate-tools-title"
                    >
                      <h2 id="candidate-tools-title">Workspace tools</h2>
                      <dl className="r26-capability-grid">
                        <div>
                          <dt>
                            <IconCode size={25} aria-hidden="true" />
                            Code editor
                          </dt>
                          <dd>Autosave on</dd>
                        </div>
                        <div>
                          <dt>
                            <IconCircleCheck size={23} aria-hidden="true" />
                            Tests
                          </dt>
                          <dd data-unavailable={!view.capabilities.execution}>
                            {view.capabilities.execution
                              ? 'Available'
                              : 'Unavailable'}
                          </dd>
                        </div>
                        <div>
                          <dt>
                            <IconMessageCode size={23} aria-hidden="true" />
                            AI assistant
                          </dt>
                          <dd data-unavailable={!view.capabilities.ai}>
                            {view.capabilities.ai ? 'Available' : 'Unavailable'}
                          </dd>
                        </div>
                      </dl>
                    </section>
                  </div>
                  <div className="r26-readiness-actions">
                    <div className="r26-readiness-start">
                      {view.dataNotice ? (
                        <label htmlFor="candidate-start-consent">
                          <input
                            id="candidate-start-consent"
                            aria-describedby="candidate-data-use-summary"
                            checked={consentAccepted}
                            disabled={busy}
                            onChange={(event) => {
                              const dataNotice = view.dataNotice;
                              setAcceptedConsent(
                                event.target.checked && dataNotice
                                  ? { sessionId, digest: dataNotice.digest }
                                  : null,
                              );
                            }}
                            type="checkbox"
                          />
                          I understand what’s recorded.
                        </label>
                      ) : null}
                      <button
                        className="r26-button r26-button-primary"
                        aria-describedby="candidate-start-timing"
                        aria-busy={busy}
                        disabled={
                          busy ||
                          accessUnavailable ||
                          invitationExpired ||
                          Boolean(view.dataNotice && !consentAccepted)
                        }
                        onClick={() => void activate()}
                        type="button"
                      >
                        {busy ? 'Starting…' : 'Start assessment'}
                        {busy ? (
                          <IconLoader2
                            className="r26-action-spinner"
                            size={20}
                            aria-hidden="true"
                          />
                        ) : (
                          <IconArrowRight size={21} aria-hidden="true" />
                        )}
                      </button>
                    </div>
                    {view.invitationExpiresAt ? (
                      <p className="r26-readiness-expiry">
                        Invitation expires{' '}
                        <LocalTime
                          timestamp={view.invitationExpiresAt}
                          absolute
                        />
                        .
                      </p>
                    ) : null}
                    {message ? (
                      <p className="r26-start-error" role="alert">
                        {message}
                      </p>
                    ) : null}
                  </div>
                </section>
              ) : (
                <>
                  {view.status === 'CREATED' ? (
                    <>
                      <h1>{scenarioTitle}</h1>
                      {view.durationSeconds ? (
                        <p className="r26-time-budget">
                          <IconClock size={17} aria-hidden="true" />
                          <span>
                            Time limit{' '}
                            <strong>
                              {formatDuration(view.durationSeconds * 1000)}
                            </strong>
                          </span>
                        </p>
                      ) : null}
                    </>
                  ) : null}

                  {isHiringExperience && view.status !== 'CREATED' ? (
                    <>
                      {!activeWorkspace && view.files.length ? (
                        <details className="r26-workspace-files" open>
                          <summary>Files</summary>
                          <ul
                            className="r26-tree-list r26-tree-root"
                            aria-label="Workspace files"
                          >
                            {renderTreeNodes(fileTree)}
                          </ul>
                        </details>
                      ) : null}
                      <section
                        className="r26-workspace-task"
                        aria-labelledby="workspace-task-heading"
                      >
                        {activeWorkspace ? (
                          <div className="r26-task-panel-bar">
                            <span>Task</span>
                            <button
                              className="r26-pref-btn r26-task-close"
                              aria-label="Close task panel"
                              onClick={closeTask}
                              type="button"
                            >
                              <IconX size={18} aria-hidden="true" />
                            </button>
                          </div>
                        ) : null}
                        <div className="r26-task-head-row">
                          <h1
                            id="workspace-task-heading"
                            ref={taskHeadingRef}
                            tabIndex={-1}
                          >
                            {scenarioTitle}
                          </h1>
                          {showEditor ? (
                            <button
                              type="button"
                              className="r26-button r26-button-primary r26-open-editor-btn"
                              onClick={() => setMobileTab('code')}
                            >
                              Open editor
                            </button>
                          ) : null}
                        </div>
                        <div
                          id="candidate-brief-content"
                          className="r26-task-reading"
                        >
                          {brief ? (
                            <ScenarioBrief
                              markdown={brief}
                              workspaceContext={briefWorkspaceContext}
                              afterIntro={taskChecklist}
                              collapseAfterIntro={activeWorkspace}
                            />
                          ) : (
                            <>
                              <p className="r26-brief">
                                The issued task details are not available in
                                this snapshot.
                              </p>
                              {taskChecklist}
                            </>
                          )}
                        </div>
                      </section>
                    </>
                  ) : (
                    <>
                      {view.status !== 'CREATED' && view.files.length > 0 ? (
                        <section
                          className="r26-file-explorer"
                          aria-label="Files explorer"
                        >
                          <div className="r26-explorer-header">
                            <p className="r26-eyebrow">Files</p>
                            <span>{view.files.length} files</span>
                          </div>
                          <ul className="r26-tree-list r26-tree-root">
                            {renderTreeNodes(fileTree)}
                          </ul>
                        </section>
                      ) : null}

                      <details
                        key={view.status}
                        className="r26-disclosure r26-task-reading"
                        open={view.status === 'CREATED'}
                      >
                        <summary>Task brief</summary>
                        <div id="candidate-brief-content">
                          {brief ? (
                            <ScenarioBrief markdown={brief} />
                          ) : (
                            <p className="r26-brief">
                              The issued task details are not available in this
                              snapshot.
                            </p>
                          )}
                        </div>
                      </details>
                      {criteria.length > 0 ? (
                        <details className="r26-disclosure r26-criteria">
                          <summary>
                            Acceptance criteria <span>{criteria.length}</span>
                          </summary>
                          <ul>
                            {criteria.map((criterion, index) => (
                              <li key={`${index}-${criterion}`}>{criterion}</li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                      {view.status === 'CREATED' ? (
                        <>
                          {renderCapabilitiesDisclosure('prestart')}
                          <div className="r26-entry-actions">
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
                                  I acknowledge and agree to this data-use
                                  notice.
                                </label>
                              </section>
                            ) : null}
                            <div className="r26-prestart">
                              <p>
                                Your assessment timer starts when you activate
                                this workspace.
                                {view.invitationExpiresAt ? (
                                  <>
                                    {' '}
                                    This invitation expires at{' '}
                                    <LocalTime
                                      timestamp={view.invitationExpiresAt}
                                      absolute
                                    />
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
                                  Confirm the data-use notice to activate your
                                  assessment.
                                </p>
                              ) : null}
                            </div>
                          </div>
                        </>
                      ) : null}
                    </>
                  )}
                </>
              )}
            </>
          ) : null}
        </aside>

        <section
          hidden={!showEditor}
          id="candidate-code-editor"
          tabIndex={-1}
          className="r26-editor-panel"
          aria-label="Candidate editor"
        >
          <div className="r26-editor-tabbar">
            {view && view.files.length > 0 ? (
              <>
                <span id="candidate-file-save-hint" className="sr-only">
                  {saveConflict
                    ? 'Resolve the saved-version conflict before switching files.'
                    : busy
                      ? 'Wait for the current action to finish before switching files.'
                      : 'Changes save automatically after you pause editing.'}
                </span>
                <label className="r26-file-switcher-label">
                  <span className="sr-only">Workspace file</span>
                  <select
                    className="r26-file-switcher"
                    value={selectedPath}
                    disabled={!canSwitchFile}
                    onChange={(event) =>
                      void selectWorkspaceFile(event.target.value)
                    }
                  >
                    {view.files.map((file) => (
                      <option value={file.path} key={file.path}>
                        {file.path}
                      </option>
                    ))}
                  </select>
                </label>
                <nav
                  ref={editorTabsRef}
                  className="r26-editor-tabs"
                  aria-label="Open file tabs"
                >
                  {resolvedOpenTabPaths.map((tabPath) => {
                    const isSelected = tabPath === selectedPath;
                    const tabHasDraft =
                      Boolean(
                        draftsByPath[tabPath] &&
                        draftsByPath[tabPath].content !==
                          draftsByPath[tabPath].baseContent,
                      ) ||
                      (isSelected && isDirty);
                    return (
                      <div className="r26-editor-tab-wrap" key={tabPath}>
                        <button
                          type="button"
                          className={`r26-editor-tab ${isSelected ? 'is-active' : ''}`}
                          aria-current={isSelected ? 'page' : undefined}
                          disabled={!canSwitchFile && !isSelected}
                          title={
                            !canSwitchFile && !isSelected
                              ? 'Resolve pending workspace action before switching files'
                              : tabPath
                          }
                          onClick={() => void selectWorkspaceFile(tabPath)}
                        >
                          <IconFileCode
                            size={14}
                            stroke={1.8}
                            aria-hidden="true"
                          />
                          <span>{fileBasename(tabPath)}</span>
                          {tabHasDraft ? (
                            <span
                              className="r26-tree-dirty-dot"
                              aria-hidden="true"
                            />
                          ) : null}
                        </button>
                        {resolvedOpenTabPaths.length > 1 ? (
                          <button
                            type="button"
                            className="r26-editor-tab-close"
                            aria-label={`Close ${fileBasename(tabPath)}`}
                            title={`Close ${fileBasename(tabPath)}`}
                            onClick={() => closeWorkspaceTab(tabPath)}
                          >
                            <IconX size={12} stroke={2} aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </nav>
              </>
            ) : (
              <span className="r26-editor-tabbar-title">
                {selectedPath || 'Code workspace'}
              </span>
            )}
            <div className="r26-editor-tabbar-actions">
              <details
                className="r26-editor-settings"
                open={
                  !isHiringExperience || view?.status !== 'ACTIVE' || undefined
                }
              >
                <summary aria-label="Editor settings" title="Editor settings">
                  <IconSettings2 size={17} stroke={1.7} aria-hidden="true" />
                </summary>
                <div
                  className="r26-editor-prefs"
                  role="group"
                  aria-label="Editor preferences"
                >
                  <button
                    type="button"
                    className="r26-pref-btn"
                    disabled={editorFontSize <= EDITOR_FONT_SIZES[0]}
                    aria-label="Decrease code font size"
                    title="Decrease code font size"
                    onClick={() =>
                      setEditorFontSize((current) => {
                        const idx = EDITOR_FONT_SIZES.indexOf(current);
                        return idx > 0 ? EDITOR_FONT_SIZES[idx - 1] : current;
                      })
                    }
                  >
                    A-
                  </button>
                  <span className="r26-font-readout" aria-live="polite">
                    {editorFontSize}px
                  </span>
                  <button
                    type="button"
                    className="r26-pref-btn"
                    disabled={
                      editorFontSize >=
                      EDITOR_FONT_SIZES[EDITOR_FONT_SIZES.length - 1]
                    }
                    aria-label="Increase code font size"
                    title="Increase code font size"
                    onClick={() =>
                      setEditorFontSize((current) => {
                        const idx = EDITOR_FONT_SIZES.indexOf(current);
                        return idx >= 0 && idx < EDITOR_FONT_SIZES.length - 1
                          ? EDITOR_FONT_SIZES[idx + 1]
                          : current;
                      })
                    }
                  >
                    A+
                  </button>
                  <button
                    type="button"
                    className="r26-pref-btn"
                    aria-pressed={lineWrap}
                    title="Toggle line wrapping"
                    onClick={() => setLineWrap((current) => !current)}
                  >
                    Wrap
                  </button>
                </div>
              </details>
              {canEdit && !pendingSubmit && activeFile ? (
                isHiringExperience ? (
                  !activeWorkspace && (pendingSave || saveConflict) ? (
                    <button
                      className="r26-button r26-button-primary r26-save-button"
                      disabled={busy || saveConflict}
                      onClick={() => void save()}
                      type="button"
                    >
                      {busy ? 'Saving…' : 'Retry save'}
                    </button>
                  ) : null
                ) : (
                  <button
                    className={`r26-button ${isDirty || pendingSave ? 'r26-button-primary' : 'r26-button-secondary'} r26-save-button`}
                    disabled={
                      busy || (!isDirty && !pendingSave) || saveConflict
                    }
                    onClick={() => void save()}
                    type="button"
                  >
                    {busy && pendingSave
                      ? 'Saving…'
                      : pendingSave
                        ? 'Retry save'
                        : 'Save work'}
                  </button>
                )
              ) : null}
              {isHiringExperience && criteria.length > 0 ? (
                <button
                  type="button"
                  id="candidate-editor-criteria-toggle"
                  className="r26-pref-btn r26-criteria-toggle-btn r26-code-mobile-action"
                  aria-expanded={showEditorCriteria}
                  onClick={() => setShowEditorCriteria((current) => !current)}
                >
                  Criteria ({checkedCriteriaCount}/{criteria.length})
                </button>
              ) : null}
              {view?.status === 'ACTIVE' && view.capabilities.execution ? (
                <button
                  type="button"
                  className="r26-run-toolbar-btn r26-code-mobile-action"
                  disabled={!canRunChecks}
                  title="Run tests against saved code (Cmd/Ctrl + Enter)"
                  onClick={() => {
                    setShowExecutionDrawer(true);
                    void runChecks();
                  }}
                >
                  <IconPlayerPlay size={13} stroke={2.2} aria-hidden="true" />
                  <span>{executionRunning ? 'Running…' : 'Run Tests'}</span>
                </button>
              ) : null}
            </div>
          </div>

          {activeWorkspace && selectedPath ? (
            <div className="r26-editor-path">
              {selectedPath.split('/').join(' / ')}
            </div>
          ) : null}

          {isHiringExperience && showEditorCriteria && criteria.length > 0 ? (
            <section
              className="r26-editor-criteria-drawer r26-code-mobile-action"
              aria-label="Acceptance criteria reference"
            >
              <div className="r26-criteria-header">
                <p className="r26-eyebrow">
                  Acceptance criteria ({checkedCriteriaCount}/{criteria.length})
                </p>
                <button
                  type="button"
                  className="r26-pref-btn r26-criteria-close-btn"
                  onClick={() => {
                    setShowEditorCriteria(false);
                    document
                      .getElementById('candidate-editor-criteria-toggle')
                      ?.focus();
                  }}
                >
                  Close
                </button>
              </div>
              <ul className="r26-criteria-checklist">
                {criteria.map((criterion, index) => {
                  const isChecked = Boolean(checkedCriteria[index]);
                  return (
                    <li key={`drawer-${index}-${criterion}`}>
                      <label
                        className={`r26-criteria-check-label ${isChecked ? 'is-checked' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(event) =>
                            setCheckedCriteria((current) => ({
                              ...current,
                              [index]: event.target.checked,
                            }))
                          }
                        />
                        <span>{criterion}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          {pendingSubmit ? (
            <p
              className="r26-message"
              role="status"
              data-testid="candidate-submit-uncertain"
            >
              {busy
                ? 'Submission is being confirmed. Editing and other actions are paused.'
                : 'The submission outcome is unknown. Your workspace is read-only until you retry the same submission.'}
            </p>
          ) : !activeWorkspace && canEdit && (pendingSave || saveConflict) ? (
            <p
              id="candidate-submit-save-status"
              className="r26-message"
              role="status"
            >
              {saveConflict
                ? 'Submission is paused until you resolve the saved-version conflict.'
                : pendingSave && busy
                  ? 'Submission is paused while the current save finishes.'
                  : 'Submission is paused. Retry the same save to confirm its result first.'}
            </p>
          ) : null}

          {message ? (
            <p className="r26-message" role="status">
              {message}
            </p>
          ) : null}

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

          {view?.status === 'CREATED' ? (
            <div className="r26-editor-empty">
              <p>
                Start the assessment to unlock the task brief and workspace
                files.
              </p>
            </div>
          ) : activeFile && currentDraft ? (
            <div
              className="r26-code-editor"
              data-readonly={editorLocked ? 'true' : 'false'}
              style={
                {
                  '--r26-editor-font-size': `${editorFontSize}px`,
                  fontSize: `${editorFontSize}px`,
                } as CSSProperties
              }
            >
              <CodeEditorSurface
                path={activeFile.path}
                value={currentDraft.content}
                theme={activeTheme}
                editable={!editorLocked}
                readOnly={editorLocked}
                lineWrap={lineWrap}
                fontSizePx={editorFontSize}
                onChange={(content) => {
                  const nextDraft = { ...currentDraft, content };
                  setDraft(nextDraft);
                  setDraftsByPath((current) => ({
                    ...current,
                    [selectedPath]: nextDraft,
                  }));
                  setMessage('');
                }}
              />
            </div>
          ) : (
            <div className="r26-editor-empty">
              <p>The issued workspace files are unavailable.</p>
            </div>
          )}

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

          {/* R2.13 Candidate Workspace Execution Panel (IDE Bottom Drawer) */}
          {view &&
          view.status !== 'CREATED' &&
          view.capabilities.execution &&
          showExecutionDrawer ? (
            <section
              className="r26-execution-panel"
              id="candidate-execution-panel"
              aria-label="Automated Checks"
              data-testid="candidate-execution-panel"
              onKeyDown={(event) => {
                if (
                  activeWorkspace &&
                  event.key === 'Escape' &&
                  !event.defaultPrevented &&
                  executionTriggerRef.current?.getClientRects().length
                ) {
                  event.preventDefault();
                  closeTests();
                }
              }}
            >
              <div className="r26-execution-header">
                <div>
                  <div className="r26-execution-title-row">
                    {!isHiringExperience ? (
                      <p className="r26-eyebrow" style={{ margin: 0 }}>
                        Automated Verification
                      </p>
                    ) : null}
                    {!isHiringExperience ? (
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
                    ) : null}
                  </div>
                  <h2>
                    {isHiringExperience ? 'Tests' : 'Approved Checks Runner'}
                  </h2>
                </div>
                <div className="r26-execution-actions">
                  <div className="r26-execution-meta">
                    <span
                      className="r26-execution-version"
                      data-testid="execution-workspace-version"
                    >
                      {isHiringExperience
                        ? `Snapshot v${activeFile?.version ?? '1'}`
                        : `Saved version ${activeFile?.version ?? 'Unknown'} · Digest ${
                            view.workspaceDigest
                              ? view.workspaceDigest.slice(0, 8)
                              : '—'
                          }`}
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
                    {isHiringExperience ? (
                      executionRunning ? (
                        <IconLoader2
                          className="r26-action-spinner"
                          size={16}
                          aria-hidden="true"
                        />
                      ) : (
                        <IconPlayerPlay size={16} aria-hidden="true" />
                      )
                    ) : null}
                    {executionRunning
                      ? isHiringExperience
                        ? 'Running tests…'
                        : 'Running checks…'
                      : isHiringExperience
                        ? 'Run tests'
                        : 'Run checks'}
                  </button>
                  {activeWorkspace ? (
                    <button
                      className="r26-pref-btn r26-tests-close"
                      aria-label="Close tests"
                      onClick={closeTests}
                      type="button"
                    >
                      <IconX size={17} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              </div>

              {executionRunning && !isHiringExperience ? (
                <div style={{ padding: '0.5rem 0' }}>
                  <CommonThreadLoader compact label="Running tests…" />
                </div>
              ) : null}

              {isDirty && !canRunChecks ? (
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
                {!isHiringExperience ? (
                  <span className="r26-status-label">Status:</span>
                ) : null}
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
                            : latestExecution.status === 'COMPLETED' &&
                                latestExecution.exitCode !== 0
                              ? 'failed'
                              : latestExecution.status.toLowerCase()
                  }`}
                  data-testid="execution-state-badge"
                >
                  {executionRunning
                    ? 'Running checks…'
                    : executionError
                      ? 'Request error'
                      : !latestExecution
                        ? isHiringExperience
                          ? 'No test runs yet'
                          : 'Never executed'
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
                  <HorizontalTabs<'stdout' | 'stderr'>
                    id="candidate-console"
                    label="Console output"
                    active={consoleOutputTab}
                    onSelect={setConsoleOutputTab}
                    className="r26-console-tabs"
                    tabClassName="r26-console-tab"
                    tabs={[
                      { id: 'stdout', label: 'STDOUT', testId: 'stdout-tab' },
                      { id: 'stderr', label: 'STDERR', testId: 'stderr-tab' },
                    ]}
                  />
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
                <div
                  className="r26-terminal-body"
                  id="candidate-console-panel"
                  role="tabpanel"
                  aria-labelledby={`candidate-console-${consoleOutputTab}`}
                  tabIndex={0}
                >
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
                    {isHiringExperience
                      ? 'Run details'
                      : isRealExecution
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

          {view && view.status !== 'CREATED' && !activeWorkspace ? (
            <footer className="r26-status-bar">
              <div className="r26-status-bar-left">
                {view.status === 'ACTIVE' ? (
                  <div className="r26-draft-state" role="status">
                    <span
                      className={
                        isDirty || pendingSave
                          ? 'r26-dot r26-dot-unsaved'
                          : 'r26-dot'
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
                  <p className="r26-readonly-note">
                    Submitted work is read-only.
                  </p>
                ) : null}
              </div>
              <div className="r26-status-bar-right">
                {selectedPath ? (
                  <code className="r26-status-path">{selectedPath}</code>
                ) : null}
                {!isHiringExperience
                  ? renderCapabilitiesDisclosure('footer')
                  : null}
              </div>
            </footer>
          ) : null}
        </section>

        {activeWorkspace ? (
          <footer className="r26-status-bar r26-active-status">
            <div className="r26-status-bar-left">
              <div
                className="r26-draft-state"
                id="candidate-submit-save-status"
                role="status"
              >
                {saveStatus === 'All changes saved' ? (
                  <IconCheck
                    className="r26-saved-check"
                    size={17}
                    aria-hidden="true"
                  />
                ) : busy || saveStatus === 'Saving…' ? (
                  <IconLoader2
                    className="r26-action-spinner"
                    size={17}
                    aria-hidden="true"
                  />
                ) : (
                  <span
                    className="r26-dot r26-dot-unsaved"
                    aria-hidden="true"
                  />
                )}
                {saveStatus}
              </div>
              {canEdit &&
              pendingSave &&
              !busy &&
              !saveConflict &&
              !pendingSubmit ? (
                <button
                  type="button"
                  className="r26-pref-btn r26-retry-save"
                  onClick={() => void save()}
                >
                  Retry save
                </button>
              ) : null}
            </div>
            {selectedPath ? (
              <code className="r26-status-path">{selectedPath}</code>
            ) : null}
          </footer>
        ) : null}

        {view?.capabilities.ai === true &&
        showAiDrawer &&
        !(isHiringExperience && view.status === 'CREATED') ? (
          <aside
            className={`r26-ai-panel ${view.capabilities.ai !== true || !aiView?.enabled ? 'r26-ai-panel-disabled' : ''}`}
            id="candidate-assistant-panel"
            aria-label="AI assistance"
            data-testid="candidate-ai-panel"
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeAssistant();
            }}
          >
            <div className="r26-ai-heading">
              <div>
                {!isHiringExperience ? (
                  <p className="r26-eyebrow">AI Assistance</p>
                ) : null}
                <h2>
                  {!view.capabilities.ai
                    ? isHiringExperience
                      ? 'Unavailable'
                      : 'Unavailable in this demo'
                    : isSyntheticAiLane
                      ? 'Synthetic Assistant (Test Lane)'
                      : 'Assistant'}
                </h2>
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.45rem',
                }}
              >
                {view.capabilities.ai && aiView?.enabled ? (
                  <span
                    className="r26-ai-budget-pill"
                    data-testid="ai-panel-budget"
                    title="Remaining questions in budget"
                  >
                    {aiView.remainingInteractions} left
                  </span>
                ) : null}
                <button
                  type="button"
                  className="r26-ai-close-btn"
                  aria-label="Close Assistant panel"
                  title="Close Assistant panel (Cmd/Ctrl + J)"
                  onClick={closeAssistant}
                >
                  <IconX size={15} stroke={2} aria-hidden="true" />
                </button>
              </div>
            </div>

            {!view.capabilities.ai ? (
              <div
                className="r26-ai-disabled-body"
                data-testid="ai-disabled-notice"
              >
                <p>
                  {isHiringExperience
                    ? 'AI assistance is disabled for this assessment.'
                    : 'AI assistance is unavailable in this demo.'}
                </p>
              </div>
            ) : !aiView ? (
              <div className="r26-ai-disabled-body">
                <CommonThreadLoader compact label="Connecting assistant…" />
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
                  {aiView.interactions.length === 0 &&
                  !(aiSubmitting && pendingAiPrompt) ? (
                    <div className="r26-ai-empty">
                      <p>Ask about the task, repository, or an error.</p>
                      {!aiInputDisabled ? (
                        <div className="r26-ai-starters">
                          {[
                            'How do these files fit together?',
                            'Which edge cases should I check?',
                            ...(view.capabilities.execution
                              ? ['Help me understand the test output']
                              : []),
                          ].map((starter) => (
                            <button
                              key={starter}
                              type="button"
                              className="r26-ai-starter-btn"
                              onClick={() => {
                                setAiPrompt(starter);
                                promptRef.current?.focus();
                              }}
                            >
                              {starter}
                            </button>
                          ))}
                        </div>
                      ) : null}
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
                              <strong>
                                {isSyntheticAiLane
                                  ? 'Synthetic Assistant (Test Lane)'
                                  : 'AI Assistant'}
                              </strong>
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
                            <AiMarkdownContent
                              content={interaction.assistantResponse}
                            />
                          </div>
                        ) : interaction.status === 'FAILED' ? (
                          <div
                            className="r26-ai-message r26-ai-message-failed"
                            data-testid="ai-failed-message"
                          >
                            <div className="r26-ai-meta">
                              <strong>
                                {isSyntheticAiLane
                                  ? 'Synthetic Assistant (Test Lane) — Error'
                                  : 'AI Assistant — Error'}
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
                  {aiSubmitting && pendingAiPrompt ? (
                    <div className="r26-ai-thread" data-testid="ai-optimistic">
                      <div
                        className="r26-ai-message r26-ai-message-candidate"
                        data-testid="ai-candidate-message"
                      >
                        <div className="r26-ai-meta">
                          <strong>You</strong>
                          <span>Just now</span>
                        </div>
                        <p>{pendingAiPrompt}</p>
                      </div>
                    </div>
                  ) : null}
                  <div ref={aiMessagesEndRef} />
                </div>

                {aiSubmitting ? (
                  <div
                    className="r26-ai-loading"
                    role="status"
                    data-testid="ai-loading-indicator"
                  >
                    <CommonThreadLoader
                      compact
                      label={
                        isSyntheticAiLane
                          ? 'Generating response from Synthetic Assistant…'
                          : 'Thinking…'
                      }
                    />
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
                    <strong>
                      {isSyntheticAiLane
                        ? 'Interaction budget exhausted'
                        : 'No questions left'}
                    </strong>
                    <p>
                      {isSyntheticAiLane
                        ? `You have reached the maximum allowance of ${aiView.totalInteractionsAllowed} questions for this assessment.`
                        : `You’ve used all ${aiView.totalInteractionsAllowed} questions for this assessment.`}
                    </p>
                  </div>
                ) : view?.status === 'CREATED' ? (
                  <div
                    className="r26-notice"
                    style={{ margin: '0 1rem 0.75rem' }}
                    data-testid="ai-prestart-notice"
                  >
                    <strong>Assessment not active</strong>
                    <p>
                      {isHiringExperience
                        ? 'Start the assessment to ask questions.'
                        : 'Activate the assessment above to ask questions.'}
                    </p>
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
                      {isSyntheticAiLane
                        ? 'Ask the Synthetic Assistant'
                        : 'Ask the AI Assistant'}
                    </label>
                    <textarea
                      id="r26-ai-prompt-input"
                      className="r26-ai-textarea"
                      placeholder="Ask a question…"
                      ref={promptRef}
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      onKeyDown={(e) => {
                        if (
                          e.key === 'Enter' &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          if (!aiInputDisabled && aiPrompt.trim()) {
                            void sendAiPrompt();
                          }
                        }
                      }}
                      disabled={aiInputDisabled}
                      maxLength={4000}
                      rows={3}
                    />
                    <div className="r26-ai-composer-footer">
                      <span className="r26-ai-char-counter">
                        {aiPrompt.length > 3600
                          ? `${4000 - aiPrompt.length} characters left`
                          : 'Enter to send · Shift+Enter for newline'}
                      </span>
                      <button
                        type="submit"
                        className="r26-button r26-button-primary"
                        disabled={aiInputDisabled || !aiPrompt.trim()}
                        data-testid="ai-submit-button"
                      >
                        {aiSubmitting
                          ? 'Sending…'
                          : isHiringExperience
                            ? 'Send'
                            : 'Ask Assistant'}
                      </button>
                    </div>
                  </form>
                )}
              </>
            )}
          </aside>
        ) : null}
      </div>

      {submitConfirmOpen && isHiringExperience && view ? (
        <dialog
          className="r26-submit-modal"
          aria-labelledby="candidate-submit-modal-title"
          aria-describedby="candidate-submit-modal-note"
          aria-busy={busy}
          ref={(dialog) => {
            if (dialog && !dialog.open) dialog.showModal();
          }}
          onCancel={(event) => {
            event.preventDefault();
            if (!busy) {
              event.currentTarget.close();
              setSubmitConfirmOpen(false);
            }
          }}
          onClick={(event) => {
            if (event.target !== event.currentTarget || busy) return;
            const box = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < box.left ||
              event.clientX > box.right ||
              event.clientY < box.top ||
              event.clientY > box.bottom
            ) {
              event.currentTarget.close();
              setSubmitConfirmOpen(false);
            }
          }}
        >
          <h2 id="candidate-submit-modal-title">Submit assessment?</h2>
          <p id="candidate-submit-modal-note" className="hiring-gate-note">
            Your saved files become read-only.
          </p>
          <div className="hiring-gate-actions">
            <button
              type="button"
              className="r26-button r26-button-secondary"
              disabled={busy}
              onClick={(event) => {
                event.currentTarget.closest('dialog')?.close();
                setSubmitConfirmOpen(false);
              }}
            >
              Keep working
            </button>
            <button
              type="button"
              className="r26-button r26-button-primary"
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? (
                <IconLoader2
                  className="r26-action-spinner"
                  size={16}
                  aria-hidden="true"
                />
              ) : null}
              {busy ? 'Submitting…' : 'Confirm submit'}
            </button>
          </div>
        </dialog>
      ) : null}
      <CommonThreadToast
        message={toastState?.message ?? null}
        tone={toastState?.tone ?? 'info'}
        onDismiss={() => setToastState(null)}
      />
    </main>
  );
}
