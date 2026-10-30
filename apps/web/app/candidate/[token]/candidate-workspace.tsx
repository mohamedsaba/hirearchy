'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';

import type { WorkspaceFileInfo } from '../../../src/sandbox/sandbox';
import type { TaskRubricSnapshot } from '../../../src/assessments/task-rubric';
import type { CandidateSessionView } from '../../../src/sessions/candidate-session-view';
import { useCandidateSession } from '../../../src/candidate/use-candidate-session';
import { presentCandidateTimer } from '../../../src/candidate/candidate-timer';
import { CandidateAiPanel } from './candidate-ai-panel';
import { CandidatePrestart } from './candidate-prestart';
import { ClarificationInbox } from './clarification-inbox';
import './candidate-workspace.css';
import {
  deriveEditorPersistenceState,
  editorPersistenceMessage,
} from './editor-persistence';
import {
  executeFileSwitch,
  executeSubmitAssessment,
  formatSaveFailureBeforeSubmit,
  formatSaveFailureBeforeSwitch,
  reconcileSubmissionResponse,
} from './candidate-workspace-actions';
import {
  beginCommand,
  canBeginCommand,
  commandPlatformError,
  completeCommand,
  failCommand,
  generateCommandEntryId,
  isCommandExecResult,
  type CommandHistoryEntry,
} from './candidate-command-state';

type CandidateWorkspaceProps = Readonly<{
  initialSession: CandidateSessionView;
  token: string;
  initialCommands?: readonly CommandHistoryEntry[];
}>;

type ApiError = Readonly<{
  error?: { code?: string; message?: string };
}>;

type WorkspacePanel = 'scenario' | 'ai';
type MobileWorkspaceView = 'code' | 'task' | 'run' | 'ai';
type EditorTheme = 'system' | 'light' | 'dark';
type EditorPreferences = Readonly<{
  fontSize: 14 | 16 | 18;
  theme: EditorTheme;
  wordWrap: boolean;
}>;

const editorPreferencesKey = 'hirearchy:candidate-editor-preferences:v1';
const defaultEditorPreferences: EditorPreferences = {
  fontSize: 14,
  theme: 'system',
  wordWrap: true,
};
const editorPreferencesChangedEvent =
  'hirearchy:candidate-editor-preferences-changed';
let cachedEditorPreferencesRaw: string | null | undefined;
let cachedEditorPreferences = defaultEditorPreferences;
let fallbackEditorPreferences = defaultEditorPreferences;

const parseEditorPreferences = (value: string): EditorPreferences => {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object') return defaultEditorPreferences;

  const stored = parsed as Partial<Record<keyof EditorPreferences, unknown>>;
  return {
    fontSize:
      stored.fontSize === 14 || stored.fontSize === 18 ? stored.fontSize : 16,
    theme:
      stored.theme === 'light' || stored.theme === 'dark'
        ? stored.theme
        : 'system',
    wordWrap: stored.wordWrap !== false,
  };
};

const getEditorPreferencesSnapshot = (): EditorPreferences => {
  try {
    const raw = window.localStorage.getItem(editorPreferencesKey);
    if (!raw) return defaultEditorPreferences;
    if (raw === cachedEditorPreferencesRaw) return cachedEditorPreferences;
    cachedEditorPreferencesRaw = raw;
    cachedEditorPreferences = parseEditorPreferences(raw);
    fallbackEditorPreferences = cachedEditorPreferences;
    return cachedEditorPreferences;
  } catch {
    return fallbackEditorPreferences;
  }
};

const persistEditorPreferences = (next: EditorPreferences) => {
  fallbackEditorPreferences = next;
  try {
    const serialized = JSON.stringify(next);
    window.localStorage.setItem(editorPreferencesKey, serialized);
    cachedEditorPreferencesRaw = serialized;
    cachedEditorPreferences = next;
  } catch {
    // Preferences stay usable in memory when browser storage is unavailable.
  }
  window.dispatchEvent(new Event(editorPreferencesChangedEvent));
};

const subscribeToEditorPreferences = (callback: () => void) => {
  window.addEventListener('storage', callback);
  window.addEventListener(editorPreferencesChangedEvent, callback);
  return () => {
    window.removeEventListener('storage', callback);
    window.removeEventListener(editorPreferencesChangedEvent, callback);
  };
};

const subscribeToSystemTheme = (callback: () => void) => {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', callback);
  return () => media.removeEventListener('change', callback);
};
const getSystemTheme = () =>
  window.matchMedia('(prefers-color-scheme: dark)').matches;

export const selectInitialWorkspaceFile = (
  files: readonly WorkspaceFileInfo[],
  scenarioFilePath?: string,
) => {
  const filePaths = files
    .filter((file) => !file.isDirectory)
    .map((file) => file.path)
    .sort((left, right) => left.localeCompare(right));

  return scenarioFilePath && filePaths.includes(scenarioFilePath)
    ? scenarioFilePath
    : filePaths[0];
};

export const CandidateWorkspace = ({
  initialSession,
  token,
  initialCommands = [],
}: CandidateWorkspaceProps) => {
  const {
    serverSession: session,
    projection,
    updateServerSession: setSession,
    uiMode,
    setUiMode,
    finalizationState,
    setFinalizationState,
  } = useCandidateSession({
    initialSession,
    token,
  });
  const isMultiFile =
    session.scenarioType === 'multi_file' ||
    session.scenario.type === 'multi_file';
  const rubricSession = session as CandidateSessionView & {
    taskRubric?: TaskRubricSnapshot | null;
  };
  const taskRubric = rubricSession.taskRubric ?? null;
  const hasTaskRubricProjection = 'taskRubric' in session;

  const [workspaceFiles, setWorkspaceFiles] = useState<
    readonly WorkspaceFileInfo[]
  >([]);
  const [selectedFile, setSelectedFile] = useState<string>(
    session.scenario.filePath ?? '',
  );
  const [initialFileStatus, setInitialFileStatus] = useState<
    'loading' | 'ready' | 'error'
  >(() => (session.status === 'ACTIVE' && isMultiFile ? 'loading' : 'ready'));
  const isInitialFileReady = !isMultiFile || initialFileStatus === 'ready';

  const [content, setContent] = useState(initialSession.workingContent);
  const [persistedContent, setPersistedContent] = useState(
    initialSession.workingContent,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savingContent, setSavingContent] = useState(
    initialSession.workingContent,
  );
  const [saveFailure, setSaveFailure] = useState<Error | null>(null);
  const [activeWorkspacePanel, setActiveWorkspacePanel] =
    useState<WorkspacePanel>('scenario');
  const [activeMobileView, setActiveMobileView] =
    useState<MobileWorkspaceView>('code');
  const editorPreferences = useSyncExternalStore(
    subscribeToEditorPreferences,
    getEditorPreferencesSnapshot,
    () => defaultEditorPreferences,
  );
  const systemIsDark = useSyncExternalStore(
    subscribeToSystemTheme,
    getSystemTheme,
    () => false,
  );
  const editorTheme =
    editorPreferences.theme === 'system'
      ? systemIsDark
        ? 'dark'
        : 'light'
      : editorPreferences.theme;
  const setEditorPreferences = (
    update: (current: EditorPreferences) => EditorPreferences,
  ) => {
    persistEditorPreferences(update(getEditorPreferencesSnapshot()));
  };

  // Command console state
  const [commandInput, setCommandInput] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [commandHistory, setCommandHistory] =
    useState<readonly CommandHistoryEntry[]>(initialCommands);

  // Pre-start / Activation state
  const [isActivating, setIsActivating] = useState(false);
  const [provisioningError, setProvisioningError] = useState<string | null>(
    null,
  );
  const workspaceHeadingRef = useRef<HTMLHeadingElement>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const terminalHeadingRef = useRef<HTMLHeadingElement>(null);
  const terminalDetailsRef = useRef<HTMLDetailsElement>(null);
  const editorSettingsRef = useRef<HTMLDetailsElement>(null);
  const activationLoadsFilesRef = useRef(false);
  const prevUxStateRef = useRef(projection.uxState);
  const focusedTerminalStateRef = useRef<string | null>(null);
  const contentRef = useRef(content);
  const selectedFileRef = useRef(selectedFile);
  const saveInFlightRef = useRef<Promise<boolean> | null>(null);
  const commandInFlightRef = useRef(false);

  const replaceEditorContent = (nextContent: string) => {
    contentRef.current = nextContent;
    setContent(nextContent);
    setPersistedContent(nextContent);
    setSaveFailure(null);
  };

  const updateEditorContent = (nextContent: string) => {
    contentRef.current = nextContent;
    setContent(nextContent);
  };

  const updateSelectedFile = (nextFile: string) => {
    selectedFileRef.current = nextFile;
    setSelectedFile(nextFile);
  };

  const persistenceState = deriveEditorPersistenceState({
    content,
    persistedContent,
    isSaving,
    saveFailed: saveFailure !== null,
  });
  const isDirty = content !== persistedContent;

  // Focus management: shift focus to workspace heading upon entering ACTIVE_WORKSPACE
  useEffect(() => {
    if (
      prevUxStateRef.current !== 'ACTIVE_WORKSPACE' &&
      projection.uxState === 'ACTIVE_WORKSPACE'
    ) {
      workspaceHeadingRef.current?.focus();
    }
    prevUxStateRef.current = projection.uxState;
  }, [projection.uxState]);

  useEffect(() => {
    if (projection.uxState === 'SUBMISSION_REVIEW') {
      reviewHeadingRef.current?.focus();
    }
  }, [projection.uxState]);

  useEffect(() => {
    if (
      (projection.uxState === 'FINALIZING' ||
        projection.uxState === 'COMPLETED') &&
      focusedTerminalStateRef.current !== projection.uxState
    ) {
      terminalHeadingRef.current?.focus();
      focusedTerminalStateRef.current = projection.uxState;
    }
  }, [projection.uxState]);

  useEffect(() => {
    if (initialCommands.length > 0 && terminalDetailsRef.current) {
      terminalDetailsRef.current.open = true;
    }
  }, [initialCommands.length]);

  const refreshFiles = async () => {
    try {
      const response = await fetch(
        `/api/candidate/sessions/${token}/workspace/tree`,
      );
      if (response.ok) {
        const data = (await response.json()) as {
          files: WorkspaceFileInfo[];
        };
        setWorkspaceFiles(data.files.filter((f) => !f.isDirectory));
      }
    } catch {
      // Ignore background refresh failure
    }
  };

  const fetchAndDisplayFile = async (filePath: string) => {
    const response = await fetch(
      `/api/candidate/sessions/${token}/workspace/file?path=${encodeURIComponent(filePath)}`,
    );
    if (!response.ok) {
      const err = (await response.json()) as ApiError;
      throw new Error(err.error?.message ?? `Could not read ${filePath}`);
    }
    const data = (await response.json()) as {
      path: string;
      content: string;
    };
    replaceEditorContent(data.content);
    updateSelectedFile(data.path);
  };

  const loadFile = async (filePath: string) => {
    setIsBusy(true);
    setNotice(null);
    try {
      await fetchAndDisplayFile(filePath);
      if (isMultiFile) setInitialFileStatus('ready');
    } catch (error) {
      if (isMultiFile) setInitialFileStatus('error');
      setNotice(
        error instanceof Error ? error.message : `Failed to load ${filePath}`,
      );
    } finally {
      setIsBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    const initialContent = contentRef.current;
    if (session.status === 'ACTIVE' && isMultiFile) {
      if (activationLoadsFilesRef.current) {
        activationLoadsFilesRef.current = false;
        return () => {
          active = false;
        };
      }
      let requestedInitialPath: string | undefined;
      void (async () => {
        try {
          const treeRes = await fetch(
            `/api/candidate/sessions/${token}/workspace/tree`,
          );
          if (!treeRes.ok) {
            throw new Error('Workspace files could not be loaded.');
          }
          const treeData = (await treeRes.json()) as {
            files: WorkspaceFileInfo[];
          };
          if (!active) return;

          const nonDirs = treeData.files.filter((f) => !f.isDirectory);
          setWorkspaceFiles(nonDirs);
          const initialPath = selectInitialWorkspaceFile(
            treeData.files,
            session.scenario.filePath,
          );
          requestedInitialPath = initialPath;
          if (!initialPath) {
            throw new Error('No workspace file is available to open.');
          }
          updateSelectedFile(initialPath);

          const fileRes = await fetch(
            `/api/candidate/sessions/${token}/workspace/file?path=${encodeURIComponent(initialPath)}`,
          );
          if (!fileRes.ok) {
            const err = (await fileRes.json()) as ApiError;
            throw new Error(
              err.error?.message ?? `Could not read ${initialPath}`,
            );
          }
          const fileData = (await fileRes.json()) as {
            path: string;
            content: string;
          };
          if (active && selectedFileRef.current === initialPath) {
            if (contentRef.current === initialContent) {
              replaceEditorContent(fileData.content);
              updateSelectedFile(fileData.path);
            }
            setInitialFileStatus('ready');
          }
        } catch (error) {
          if (
            active &&
            (!requestedInitialPath ||
              selectedFileRef.current === requestedInitialPath)
          ) {
            setNotice(
              error instanceof Error
                ? error.message
                : 'Workspace files could not be loaded.',
            );
            setInitialFileStatus('error');
          }
        }
      })();
    }
    return () => {
      active = false;
    };
  }, [session.status, session.scenario.filePath, isMultiFile, token]);

  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(
      `/api/candidate/sessions/${token}${path}`,
      init,
    );
    if (!response.ok) {
      const result = (await response.json()) as ApiError;
      throw new Error(
        result.error?.message ?? 'The request could not be completed.',
      );
    }

    return (await response.json()) as CandidateSessionView;
  };

  const saveCurrentFile = (): Promise<boolean> => {
    if (!isInitialFileReady) return Promise.resolve(false);
    if (saveInFlightRef.current) return saveInFlightRef.current;

    const savedContent = contentRef.current;
    setSavingContent(savedContent);
    const savedFile = selectedFileRef.current;
    setIsSaving(true);
    setSaveFailure(null);

    const saveAttempt = (async () => {
      try {
        let serverContent: string;
        if (isMultiFile) {
          const res = await fetch(
            `/api/candidate/sessions/${token}/workspace/file`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: savedFile, content: savedContent }),
            },
          );
          if (!res.ok) {
            const err = (await res.json()) as ApiError;
            throw new Error(err.error?.message ?? 'Failed to save file.');
          }
          serverContent = ((await res.json()) as { content: string }).content;
          await refreshFiles();
        } else {
          const nextSession = await request('/file', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: savedContent }),
          });
          setSession(nextSession);
          serverContent = nextSession.workingContent;
        }

        setPersistedContent(serverContent);
        const stillCurrent =
          contentRef.current === savedContent &&
          selectedFileRef.current === savedFile;
        if (stillCurrent) updateEditorContent(serverContent);
        return stillCurrent;
      } catch (error) {
        const failure =
          error instanceof Error
            ? error
            : new Error('The save request failed.');
        setSaveFailure(failure);
        throw failure;
      } finally {
        setIsSaving(false);
        saveInFlightRef.current = null;
      }
    })();
    saveInFlightRef.current = saveAttempt;
    return saveAttempt;
  };

  const handleSelectFile = async (filePath: string) => {
    if (filePath === selectedFile || isBusy) return;
    setIsBusy(true);
    setNotice(null);
    try {
      await executeFileSwitch({
        currentFile: selectedFile,
        targetFile: filePath,
        content,
        isDirty,
        isBusy: false,
        saveCurrentFile,
        loadTargetFile: async (path) => {
          const response = await fetch(
            `/api/candidate/sessions/${token}/workspace/file?path=${encodeURIComponent(path)}`,
          );
          if (!response.ok) {
            const err = (await response.json()) as ApiError;
            throw new Error(err.error?.message ?? `Could not read ${path}`);
          }
          return (await response.json()) as { path: string; content: string };
        },
        onSaveFailure: () => {
          setNotice(formatSaveFailureBeforeSwitch(selectedFile));
        },
        onSwitchSuccess: (loaded) => {
          replaceEditorContent(loaded.content);
          updateSelectedFile(loaded.path);
          setInitialFileStatus('ready');
        },
        onLoadFailure: (error) => {
          setNotice(error.message);
        },
        onSaveIncomplete: () => {
          setNotice(
            'Your newer edits are still unsaved. Save again before switching files.',
          );
        },
      });
    } finally {
      setIsBusy(false);
    }
  };

  const runAction = async (action: () => Promise<void>) => {
    if (isBusy) return;
    setIsBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The request failed.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleStartAssessment = async () => {
    if (isActivating || session.status !== 'CREATED') return;
    setIsActivating(true);
    setProvisioningError(null);
    setUiMode('provisioning');

    try {
      const nextSession = await request('/activate', { method: 'POST' });
      if (
        nextSession.scenarioType === 'multi_file' ||
        nextSession.scenario.type === 'multi_file'
      ) {
        activationLoadsFilesRef.current = true;
        setInitialFileStatus('loading');
      }
      setSession(nextSession);
      replaceEditorContent(nextSession.workingContent);
      if (nextSession.scenario?.filePath) {
        updateSelectedFile(nextSession.scenario.filePath);
      }
      setNotice('Session active. Sandbox is ready and editing is enabled.');
      if (
        nextSession.scenarioType === 'multi_file' ||
        nextSession.scenario.type === 'multi_file'
      ) {
        const treeRes = await fetch(
          `/api/candidate/sessions/${token}/workspace/tree`,
        );
        if (!treeRes.ok) {
          setInitialFileStatus('error');
          setNotice('Workspace files could not be loaded.');
          return;
        }
        const treeData = (await treeRes.json()) as {
          files: WorkspaceFileInfo[];
        };
        const nonDirs = treeData.files.filter((f) => !f.isDirectory);
        setWorkspaceFiles(nonDirs);
        const initialPath = selectInitialWorkspaceFile(
          treeData.files,
          nextSession.scenario.filePath,
        );
        if (!initialPath) {
          setInitialFileStatus('error');
          setNotice('No workspace file is available to open.');
          return;
        }
        updateSelectedFile(initialPath);
        await loadFile(initialPath);
      }
    } catch (activateError) {
      // Ambiguous network failure recovery:
      // Re-fetch canonical candidate session projection before assuming state
      try {
        const checkRes = await fetch(`/api/candidate/sessions/${token}`);
        if (checkRes.ok) {
          const freshSession = (await checkRes.json()) as CandidateSessionView;
          if (freshSession.status === 'ACTIVE') {
            if (
              freshSession.scenarioType === 'multi_file' ||
              freshSession.scenario.type === 'multi_file'
            ) {
              activationLoadsFilesRef.current = true;
              setInitialFileStatus('loading');
            }
            setSession(freshSession);
            replaceEditorContent(freshSession.workingContent);
            if (freshSession.scenario?.filePath) {
              updateSelectedFile(freshSession.scenario.filePath);
            }
            setNotice(
              'Session active. Sandbox is ready and editing is enabled.',
            );
            if (
              freshSession.scenarioType === 'multi_file' ||
              freshSession.scenario.type === 'multi_file'
            ) {
              const treeRes = await fetch(
                `/api/candidate/sessions/${token}/workspace/tree`,
              );
              if (!treeRes.ok) {
                setInitialFileStatus('error');
                setNotice('Workspace files could not be loaded.');
              } else {
                const treeData = (await treeRes.json()) as {
                  files: WorkspaceFileInfo[];
                };
                const nonDirs = treeData.files.filter((f) => !f.isDirectory);
                setWorkspaceFiles(nonDirs);
                const initialPath = selectInitialWorkspaceFile(
                  treeData.files,
                  freshSession.scenario.filePath,
                );
                if (!initialPath) {
                  setInitialFileStatus('error');
                  setNotice('No workspace file is available to open.');
                } else {
                  updateSelectedFile(initialPath);
                  await loadFile(initialPath);
                }
              }
            }
            return;
          }
        }
      } catch {
        // Fall through to error state
      }

      const message =
        activateError instanceof Error
          ? activateError.message
          : 'Failed to prepare assessment environment. Please try again.';
      setProvisioningError(message);
    } finally {
      setIsActivating(false);
    }
  };

  const handleRetryProvisioning = () => {
    setProvisioningError(null);
    void handleStartAssessment();
  };

  const save = () =>
    runAction(async () => {
      const savedCurrentContent = await saveCurrentFile();
      setNotice(
        savedCurrentContent
          ? isMultiFile
            ? `Saved ${selectedFile}.`
            : 'Saved.'
          : 'Your newer edits are still unsaved. Save again when ready.',
      );
    });

  const submit = async () => {
    if (
      !isInitialFileReady ||
      isBusy ||
      isSaving ||
      isExecuting ||
      finalizationState === 'in_flight' ||
      !projection.capabilities.canSubmit
    ) {
      return;
    }

    setIsBusy(true);
    setNotice(null);
    try {
      await executeSubmitAssessment({
        isDirty,
        isBusy: false,
        saveCurrentFile,
        submitAssessment: async () => {
          setFinalizationState('in_flight');
          try {
            const nextSession = await request('/submit', { method: 'POST' });
            setSession(nextSession);
          } catch {
            try {
              const response = await fetch(`/api/candidate/sessions/${token}`);
              if (!response.ok) throw new Error('Session refresh failed.');
              const nextSession =
                (await response.json()) as CandidateSessionView;
              setSession(nextSession);
              if (reconcileSubmissionResponse(nextSession) === 'resume') {
                setFinalizationState('idle');
                setUiMode('workspace');
                setNotice(
                  'Submission was not admitted. Check the current assessment status.',
                );
              }
            } catch {
              setNotice("We're checking your submission status.");
            }
          }
        },
        onSaveFailure: () => setNotice(formatSaveFailureBeforeSubmit()),
        onSaveIncomplete: () =>
          setNotice(
            'Your newer edits are still unsaved. The assessment was not submitted.',
          ),
        onSubmitSuccess: () => {},
        onSubmitFailure: () => {},
      });
    } finally {
      setIsBusy(false);
    }
  };

  const canRunCommands =
    projection.capabilities.canRunCommands && session.terminalEnabled !== false;

  const executeCommand = async (
    e?: React.FormEvent,
    commandOverride?: string,
  ) => {
    if (e) e.preventDefault();
    const cmd = (commandOverride ?? commandInput).trim();
    if (
      !canBeginCommand(
        cmd,
        commandInFlightRef.current,
        canRunCommands && isInitialFileReady && !isBusy,
      )
    ) {
      return;
    }

    const entryId = generateCommandEntryId();
    commandInFlightRef.current = true;
    setIsExecuting(true);
    setCommandHistory((history) => beginCommand(history, entryId, cmd));
    try {
      const response = await fetch(
        `/api/candidate/sessions/${token}/terminal/exec`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: cmd }),
        },
      );

      if (!response.ok) {
        const errorJson = (await response
          .json()
          .catch(() => null)) as ApiError | null;
        setCommandHistory((history) =>
          failCommand(
            history,
            entryId,
            commandPlatformError(
              response.status,
              errorJson?.error?.code,
              errorJson?.error?.message,
            ),
          ),
        );
        return;
      }

      const result = (await response.json()) as unknown;
      if (!isCommandExecResult(result)) {
        setCommandHistory((history) =>
          failCommand(
            history,
            entryId,
            'Hirearchy Software returned an incomplete command result. Try again.',
          ),
        );
        return;
      }

      setCommandHistory((history) => completeCommand(history, entryId, result));
      setCommandInput('');
    } catch {
      setCommandHistory((history) =>
        failCommand(
          history,
          entryId,
          commandPlatformError(null, undefined, undefined),
        ),
      );
    } finally {
      commandInFlightRef.current = false;
      setIsExecuting(false);
    }
  };

  const runScenarioChecks = () => {
    if (!canRunCommands || !isInitialFileReady || isBusy || isExecuting) return;
    if (session.scenario.id !== 'scenario-002-booking-notification-retry')
      return;
    if (terminalDetailsRef.current) terminalDetailsRef.current.open = true;
    setActiveMobileView('run');
    void executeCommand(undefined, 'pytest');
  };

  const isActive =
    session.status === 'ACTIVE' && projection.capabilities.canEdit;
  const isSubmitted = session.status === 'SUBMITTED';
  const activeFilePath = isMultiFile ? selectedFile : session.scenario.filePath;
  const hasSelectedFile = Boolean(activeFilePath);
  const displayedFiles: readonly Pick<
    WorkspaceFileInfo,
    'path' | 'isDirectory'
  >[] = isMultiFile
    ? workspaceFiles
    : activeFilePath
      ? [{ path: activeFilePath, isDirectory: false }]
      : [];
  const filesByDirectory = new Map<
    string,
    Pick<WorkspaceFileInfo, 'path' | 'isDirectory'>[]
  >();
  for (const file of displayedFiles) {
    const directory = file.path.split('/').slice(0, -1).join('/');
    filesByDirectory.set(directory, [
      ...(filesByDirectory.get(directory) ?? []),
      file,
    ]);
  }
  const editorExtensions = useMemo(() => {
    const language = activeFilePath?.endsWith('.py')
      ? python()
      : javascript({
          jsx:
            activeFilePath?.endsWith('.jsx') ||
            activeFilePath?.endsWith('.tsx'),
          typescript:
            activeFilePath?.endsWith('.ts') || activeFilePath?.endsWith('.tsx'),
        });
    return [
      language,
      EditorView.contentAttributes.of({
        'aria-label': `Edit ${activeFilePath || 'No workspace file available'}`,
        spellcheck: 'false',
        tabindex: '0',
      }),
      ...(editorPreferences.wordWrap ? [EditorView.lineWrapping] : []),
    ];
  }, [activeFilePath, editorPreferences.wordWrap]);
  const timer =
    session.status === 'ACTIVE' && session.closureReason === null
      ? presentCandidateTimer(projection.remainingMs, session.durationSeconds)
      : null;
  const closeSubmissionReview = () => {
    setUiMode('workspace');
    requestAnimationFrame(() => submitButtonRef.current?.focus());
  };

  if (session.status === 'CREATED') {
    return (
      <CandidatePrestart
        session={session}
        uiMode={uiMode}
        setUiMode={setUiMode}
        onStartAssessment={handleStartAssessment}
        isActivating={isActivating}
        provisioningError={provisioningError}
        onRetryProvisioning={handleRetryProvisioning}
      />
    );
  }

  if (projection.uxState === 'FINALIZING') {
    return (
      <main className="candidate-workspace software-product workspace-shell terminal-candidate-state">
        <header className="workspace-header">
          <div>
            <div className="candidate-brand">
              <strong>Hirearchy</strong>
              <span>Software</span>
            </div>
            <p className="session-reference">Session {session.id}</p>
          </div>
          <span className="status" role="status">
            Finalizing
          </span>
        </header>
        <section
          className="prestart-card"
          aria-labelledby="finalizing-title"
          role="status"
        >
          <p className="eyebrow">Assessment</p>
          <h1 id="finalizing-title" ref={terminalHeadingRef} tabIndex={-1}>
            Finalizing your assessment…
          </h1>
          <p className="summary">
            Submission has begun. No more changes can be accepted while
            finalization is underway.
          </p>
        </section>
      </main>
    );
  }

  if (projection.uxState === 'COMPLETED') {
    const isTimeout = projection.completionVariant === 'timeout';
    return (
      <main className="candidate-workspace software-product workspace-shell terminal-candidate-state">
        <header className="workspace-header">
          <div>
            <div className="candidate-brand">
              <strong>Hirearchy</strong>
              <span>Software</span>
            </div>
            <p className="session-reference">Session {session.id}</p>
          </div>
          <span className="status" role="status">
            {isTimeout ? 'Time ended' : 'Submitted'}
          </span>
        </header>
        <section className="prestart-card" aria-labelledby="completion-title">
          <p className="eyebrow">Assessment complete</p>
          <h1 id="completion-title" ref={terminalHeadingRef} tabIndex={-1}>
            {isTimeout ? 'Assessment time ended' : 'Assessment submitted'}
          </h1>
          <p className="summary">
            {projection.completionMessage} No more changes can be made.
          </p>
          {session.status === 'SUBMITTED' ? (
            <ClarificationInbox token={token} />
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main
      className={`candidate-workspace software-product workspace-shell ${projection.uxState === 'ACTIVE_WORKSPACE' ? 'workspace-shell-active' : 'workspace-shell-readonly'}`}
      data-editor-theme={editorPreferences.theme}
      data-workspace-state={projection.uxState}
    >
      <header className="workspace-header">
        <div>
          <div className="candidate-brand">
            <strong>Hirearchy</strong>
            <span>Software</span>
          </div>
        </div>
        <div className="workspace-session-actions">
          {timer ? (
            <p
              className={`workspace-timer workspace-timer-${timer.state.toLowerCase()}`}
            >
              <img src="/software/icons/clock.svg" alt="" aria-hidden="true" />
              <span>Time remaining</span>
              <strong>{timer.display}</strong>
              {timer.statusText && timer.state !== 'NORMAL' ? (
                <span className="workspace-timer-status">
                  {timer.statusText}
                </span>
              ) : null}
            </p>
          ) : null}
          {isActive ? (
            <button
              className="button button-primary"
              disabled={isBusy || !isInitialFileReady}
              onClick={() => setUiMode('submission_review')}
              ref={submitButtonRef}
              type="button"
            >
              Review submission
              <img
                src="/software/icons/arrow-right.svg"
                alt=""
                aria-hidden="true"
              />
            </button>
          ) : null}
          <span
            className={`candidate-save-indicator candidate-save-${!isInitialFileReady ? (initialFileStatus === 'error' ? 'failed' : 'loading') : persistenceState.toLowerCase()}`}
            role="status"
            aria-live="polite"
          >
            {isInitialFileReady
              ? editorPersistenceMessage(
                  persistenceState,
                  isSaving && content !== savingContent,
                )
              : initialFileStatus === 'error'
                ? 'Workspace unavailable'
                : 'Loading workspace…'}
          </span>
        </div>
      </header>

      {projection.uxState === 'TIME_LIMIT_REACHED' ? (
        <p className="deadline-reached-notice" role="status" aria-live="polite">
          Time limit reached. New work is no longer accepted.
        </p>
      ) : null}

      {projection.uxState === 'SUBMISSION_REVIEW' ? (
        <section
          className="submission-review"
          aria-labelledby="submission-review-title"
        >
          <p className="eyebrow">Submission review</p>
          <h1 id="submission-review-title" ref={reviewHeadingRef} tabIndex={-1}>
            Review your submission
          </h1>
          <p>
            Submitting is final. Further editing ends once submission is
            admitted.
          </p>
          <p className="submission-review-persistence" role="status">
            Editor status: {editorPersistenceMessage(persistenceState, isDirty)}
            .
            {persistenceState === 'SAVED'
              ? ' Your current editor work is ready for final submission.'
              : ' Current editor work must be saved before final submission.'}
          </p>
          <div className="button-row">
            <button
              className="button button-secondary"
              disabled={isBusy || finalizationState === 'in_flight'}
              onClick={closeSubmissionReview}
              type="button"
            >
              Back
            </button>
            <button
              className="button button-primary"
              disabled={
                isBusy ||
                !isInitialFileReady ||
                isSaving ||
                isExecuting ||
                finalizationState === 'in_flight' ||
                !projection.capabilities.canSubmit
              }
              onClick={() => void submit()}
              type="button"
            >
              Submit Assessment
            </button>
          </div>
          {notice ? (
            <p className="editor-message" role="status">
              {notice}
            </p>
          ) : null}
        </section>
      ) : null}

      <div
        className="candidate-workspace-content"
        aria-hidden={projection.uxState === 'SUBMISSION_REVIEW' || undefined}
        inert={projection.uxState === 'SUBMISSION_REVIEW'}
      >
        <div
          className={`candidate-workbench workspace-grid workspace-view-${activeWorkspacePanel}`}
          data-mobile-view={activeMobileView}
        >
          <nav className="candidate-mobile-nav" aria-label="Workspace views">
            <button
              type="button"
              aria-controls="workspace-editor"
              aria-current={activeMobileView === 'code' ? 'page' : undefined}
              onClick={() => setActiveMobileView('code')}
            >
              <img src="/software/icons/file.svg" alt="" aria-hidden="true" />
              Code
            </button>
            <button
              type="button"
              aria-controls="workspace-scenario"
              aria-current={activeMobileView === 'task' ? 'page' : undefined}
              onClick={() => {
                setActiveWorkspacePanel('scenario');
                setActiveMobileView('task');
              }}
            >
              <img
                src="/software/icons/book-open-text.svg"
                alt=""
                aria-hidden="true"
              />
              Task
            </button>
            <button
              type="button"
              aria-controls="workspace-commands"
              aria-current={activeMobileView === 'run' ? 'page' : undefined}
              onClick={() => {
                if (terminalDetailsRef.current) {
                  terminalDetailsRef.current.open = true;
                }
                setActiveMobileView('run');
              }}
            >
              <img
                src="/software/icons/terminal-window.svg"
                alt=""
                aria-hidden="true"
              />
              Run
            </button>
            <button
              type="button"
              aria-controls="workspace-ai"
              aria-current={activeMobileView === 'ai' ? 'page' : undefined}
              onClick={() => {
                setActiveWorkspacePanel('ai');
                setActiveMobileView('ai');
              }}
            >
              <img
                src="/software/icons/sparkle.svg"
                alt=""
                aria-hidden="true"
              />
              Weft
            </button>
          </nav>

          <aside className="candidate-file-rail" aria-label="Workspace files">
            <h2>Files</h2>
            <p className="candidate-root-folder">Workspace</p>
            <nav aria-label="Workspace files">
              {Array.from(filesByDirectory, ([directory, files]) => (
                <div className="candidate-file-group" key={directory || '.'}>
                  {directory ? (
                    <p className="candidate-file-directory">
                      <img
                        src="/software/icons/folder-simple.svg"
                        alt=""
                        aria-hidden="true"
                      />
                      {directory}
                    </p>
                  ) : null}
                  {files.map((file) => (
                    <button
                      key={file.path}
                      title={file.path}
                      type="button"
                      aria-current={
                        file.path === activeFilePath ? 'page' : undefined
                      }
                      onClick={() =>
                        isMultiFile
                          ? void handleSelectFile(file.path)
                          : undefined
                      }
                      disabled={!isActive || !isMultiFile || isBusy}
                      className="candidate-file-item"
                    >
                      <img
                        src="/software/icons/file.svg"
                        alt=""
                        aria-hidden="true"
                      />
                      {file.path.split('/').at(-1)}
                    </button>
                  ))}
                </div>
              ))}
            </nav>
          </aside>

          <nav className="candidate-side-tabs" aria-label="Task and AI panel">
            <button
              type="button"
              aria-controls="workspace-scenario"
              aria-pressed={activeWorkspacePanel !== 'ai'}
              onClick={() => {
                setActiveWorkspacePanel('scenario');
                setActiveMobileView('task');
              }}
            >
              <img
                src="/software/icons/book-open-text.svg"
                alt=""
                aria-hidden="true"
              />
              Task
            </button>
            <button
              type="button"
              aria-controls="workspace-ai"
              aria-pressed={activeWorkspacePanel === 'ai'}
              onClick={() => {
                setActiveWorkspacePanel('ai');
                setActiveMobileView('ai');
              }}
            >
              <img
                src="/software/icons/sparkle.svg"
                alt=""
                aria-hidden="true"
              />
              Weft
            </button>
          </nav>

          <section
            id="workspace-scenario"
            className="brief-panel"
            aria-labelledby="scenario-title"
            tabIndex={0}
          >
            <h1 id="scenario-title" tabIndex={-1} ref={workspaceHeadingRef}>
              {session.scenario.title}
            </h1>
            <p className="brief-copy">{session.scenario.brief}</p>

            <h2>Expected behavior</h2>
            <ul className="criteria-list">
              {(session.scenario.acceptanceCriteria ?? []).map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
            {taskRubric?.criteria.length ? (
              <details className="candidate-rubric-disclosure">
                <summary>Task review criteria</summary>
                <p>
                  These criteria apply to your submitted work sample. They are
                  not a general suitability rating.
                </p>
                <ol className="candidate-rubric-list">
                  {taskRubric.criteria.map((criterion) => (
                    <li key={criterion.id}>
                      <div>
                        <strong>{criterion.label}</strong>
                        <span>{criterion.description}</span>
                        {criterion.applicability.kind !== 'always' ? (
                          <small>{criterion.applicability.rule}</small>
                        ) : null}
                      </div>
                      <span>{criterion.weight}%</span>
                    </li>
                  ))}
                </ol>
              </details>
            ) : (
              <p className="candidate-rubric-unavailable" role="note">
                {hasTaskRubricProjection
                  ? 'This session has no saved task rubric. A scored task report will not be available.'
                  : 'Task-specific criteria are not available for this session yet.'}
              </p>
            )}
          </section>

          <section
            id="workspace-editor"
            className="editor-panel"
            aria-labelledby="file-name"
            tabIndex={-1}
            onKeyDownCapture={(event) => {
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key.toLowerCase() === 's'
              ) {
                event.preventDefault();
                if (
                  isActive &&
                  isInitialFileReady &&
                  !isBusy &&
                  !isSaving &&
                  isDirty
                )
                  void save();
              }
            }}
          >
            <div className="file-bar">
              <div>
                <h2 id="file-name">
                  {activeFilePath || 'No workspace file available'}
                </h2>
              </div>
              {isActive && hasSelectedFile ? (
                <>
                  <button
                    className="button button-secondary"
                    disabled={isBusy || isSaving || !isDirty}
                    onClick={save}
                    title="Save current file (Ctrl+S or ⌘S)"
                    type="button"
                  >
                    Save
                  </button>
                </>
              ) : null}
            </div>

            <div
              className="candidate-editor-buffer"
              data-font-size={editorPreferences.fontSize}
              data-theme={editorTheme}
              data-word-wrap={editorPreferences.wordWrap ? 'on' : 'off'}
            >
              {isMultiFile && initialFileStatus === 'loading' ? (
                <p className="candidate-file-load-status" role="status">
                  Loading workspace file…
                </p>
              ) : null}
              {isMultiFile && initialFileStatus === 'error' ? (
                <div className="candidate-file-load-status" role="alert">
                  <p>{notice ?? 'Workspace files could not be loaded.'}</p>
                  <button
                    className="button button-secondary"
                    onClick={() => window.location.reload()}
                    type="button"
                  >
                    Reload workspace
                  </button>
                </div>
              ) : null}
              <CodeMirror
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: false,
                  highlightActiveLine: false,
                }}
                className="candidate-code-editor"
                editable={
                  isActive &&
                  hasSelectedFile &&
                  isInitialFileReady &&
                  !(isBusy && !isSaving)
                }
                extensions={editorExtensions}
                onChange={(value) => {
                  updateEditorContent(value);
                  setNotice(null);
                }}
                readOnly={
                  !isActive ||
                  !hasSelectedFile ||
                  !isInitialFileReady ||
                  (isBusy && !isSaving)
                }
                theme={editorTheme}
                value={content}
              />
            </div>
          </section>

          <section
            className="candidate-bottom-toolbar"
            aria-label="Workspace toolbar"
          >
            <section
              id="workspace-commands"
              className="terminal-panel"
              aria-labelledby="terminal-title"
              tabIndex={-1}
            >
              <details className="terminal-details" ref={terminalDetailsRef}>
                <summary className="terminal-header">
                  <div>
                    <h3 id="terminal-title">
                      <img
                        src="/software/icons/terminal-window.svg"
                        alt=""
                        aria-hidden="true"
                      />
                      Terminal · commands & output
                    </h3>
                    <p className="command-description">
                      Run commands and tests inside the assessment environment.
                    </p>
                  </div>
                  <span
                    aria-label={
                      session.terminalEnabled === false
                        ? 'Terminal disabled for this assessment'
                        : undefined
                    }
                    className={`file-kicker ${!canRunCommands ? 'candidate-terminal-status' : ''}`}
                    title={
                      session.terminalEnabled === false
                        ? 'Terminal disabled for this assessment'
                        : undefined
                    }
                  >
                    {canRunCommands
                      ? 'Available'
                      : session.terminalEnabled === false
                        ? 'Disabled'
                        : projection.uxState === 'TIME_LIMIT_REACHED'
                          ? 'Unavailable: time limit reached'
                          : isSubmitted
                            ? 'Unavailable: assessment submitted'
                            : 'Unavailable: assessment inactive'}
                  </span>
                </summary>

                <div className="terminal-body">
                  <form className="terminal-form" onSubmit={executeCommand}>
                    <input
                      aria-label="Command"
                      className="terminal-input"
                      disabled={
                        !canRunCommands ||
                        !isInitialFileReady ||
                        isBusy ||
                        isExecuting
                      }
                      onChange={(e) => setCommandInput(e.target.value)}
                      placeholder={
                        !isInitialFileReady
                          ? 'Loading workspace file…'
                          : canRunCommands
                            ? 'Enter a command'
                            : session.terminalEnabled === false
                              ? 'Terminal is disabled for this assessment'
                              : 'Commands are unavailable'
                      }
                      type="text"
                      value={commandInput}
                    />
                    <button
                      className="terminal-button"
                      disabled={
                        !canRunCommands ||
                        !isInitialFileReady ||
                        isBusy ||
                        isExecuting ||
                        !commandInput.trim()
                      }
                      type="submit"
                    >
                      <img
                        src="/software/icons/play.svg"
                        alt=""
                        aria-hidden="true"
                      />
                      {isExecuting ? 'Running…' : 'Run'}
                    </button>
                  </form>

                  {commandHistory.length > 0 ? (
                    <ol className="terminal-log" aria-label="Command history">
                      {commandHistory.map((item) => (
                        <li className="command-entry" key={item.id}>
                          <div className="command-meta">
                            <code className="command-text">{item.command}</code>
                            {item.state === 'RUNNING' ? (
                              <span
                                className="badge badge-running"
                                role="status"
                              >
                                Command running
                              </span>
                            ) : item.state === 'TIMED_OUT' ? (
                              <span className="badge badge-timeout">
                                Command timed out
                              </span>
                            ) : item.state === 'COMPLETED_SUCCESS' ? (
                              <span className="badge badge-success">
                                Completed: exit 0
                              </span>
                            ) : item.state === 'COMPLETED_FAILURE' ? (
                              <span className="badge badge-error">
                                {item.result?.exitCode === null
                                  ? 'Completed without an exit code'
                                  : `Completed: non-zero exit ${item.result?.exitCode}`}
                              </span>
                            ) : (
                              <span className="badge badge-error">
                                Hirearchy Software could not run command
                              </span>
                            )}
                            {item.result ? (
                              <span>{item.result.durationMs}ms</span>
                            ) : null}
                            {item.result?.stdoutTruncated ? (
                              <span className="badge badge-truncated">
                                Standard output truncated (
                                {item.result.stdoutBytes} B)
                              </span>
                            ) : null}
                            {item.result?.stderrTruncated ? (
                              <span className="badge badge-truncated">
                                Standard error truncated (
                                {item.result.stderrBytes} B)
                              </span>
                            ) : null}
                          </div>

                          {item.platformError ? (
                            <p className="command-platform-error" role="alert">
                              {item.platformError}
                            </p>
                          ) : null}

                          {item.result?.stdoutPreview ? (
                            <section aria-label="Standard output">
                              <p className="command-output-label">
                                Standard output
                              </p>
                              <pre className="command-output">
                                {item.result.stdoutPreview}
                              </pre>
                            </section>
                          ) : null}

                          {item.result?.stderrPreview ? (
                            <section aria-label="Standard error">
                              <p className="command-output-label">
                                Standard error
                              </p>
                              <pre className="command-output stderr">
                                {item.result.stderrPreview}
                              </pre>
                            </section>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </div>
              </details>
            </section>
            <div className="editor-footer">
              {saveFailure ? (
                <p className="editor-message save-failure" role="alert">
                  We could not save your changes. Your edits are still here. Try
                  saving again.
                </p>
              ) : (
                <p
                  className={`editor-message ${notice ? 'candidate-message-visible' : ''}`}
                  aria-live="polite"
                >
                  {notice ??
                    (projection.uxState === 'TIME_LIMIT_REACHED'
                      ? 'The assessment time limit has been reached. New modifications are no longer permitted.'
                      : isSubmitted
                        ? (projection.completionMessage ??
                          `Submitted ${new Date(session.submittedAt ?? '').toLocaleString()}.`)
                        : 'Edits persist only after Save or Submit.')}
                </p>
              )}
              <div className="button-row">
                <details
                  className="candidate-editor-settings"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      editorSettingsRef.current?.removeAttribute('open');
                      editorSettingsRef.current
                        ?.querySelector('summary')
                        ?.focus();
                    }
                  }}
                  ref={editorSettingsRef}
                >
                  <summary>
                    <img
                      src="/software/icons/gear-six.svg"
                      alt=""
                      aria-hidden="true"
                    />
                    Editor settings
                  </summary>
                  <div className="candidate-editor-settings-controls">
                    <div className="candidate-editor-settings-heading">
                      <h2>Editor settings</h2>
                      <button
                        aria-label="Close editor settings"
                        onClick={() => {
                          editorSettingsRef.current?.removeAttribute('open');
                          editorSettingsRef.current
                            ?.querySelector('summary')
                            ?.focus();
                        }}
                        type="button"
                      >
                        <img
                          src="/software/icons/x.svg"
                          alt=""
                          aria-hidden="true"
                        />
                      </button>
                    </div>
                    <fieldset className="candidate-editor-size-options">
                      <legend>Text size</legend>
                      {([14, 16, 18] as const).map((fontSize) => (
                        <label key={fontSize}>
                          <input
                            checked={editorPreferences.fontSize === fontSize}
                            name="candidate-editor-font-size"
                            onChange={() =>
                              setEditorPreferences((current) => ({
                                ...current,
                                fontSize,
                              }))
                            }
                            type="radio"
                            value={fontSize}
                          />
                          <span>{fontSize}</span>
                        </label>
                      ))}
                    </fieldset>
                    <fieldset>
                      <legend>Editor theme</legend>
                      {(['system', 'light', 'dark'] as const).map((theme) => (
                        <label key={theme}>
                          <input
                            checked={editorPreferences.theme === theme}
                            name="candidate-editor-theme"
                            onChange={() =>
                              setEditorPreferences((current) => ({
                                ...current,
                                theme,
                              }))
                            }
                            type="radio"
                            value={theme}
                          />
                          <span>{theme[0].toUpperCase() + theme.slice(1)}</span>
                        </label>
                      ))}
                    </fieldset>
                    <label className="candidate-editor-wrap-setting">
                      <input
                        checked={editorPreferences.wordWrap}
                        onChange={(event) =>
                          setEditorPreferences((current) => ({
                            ...current,
                            wordWrap: event.target.checked,
                          }))
                        }
                        type="checkbox"
                      />
                      <span>Wrap long lines</span>
                    </label>
                  </div>
                </details>
                {canRunCommands &&
                session.scenario.id ===
                  'scenario-002-booking-notification-retry' ? (
                  <button
                    className="candidate-run-checks"
                    disabled={isBusy || !isInitialFileReady || isExecuting}
                    onClick={runScenarioChecks}
                    type="button"
                  >
                    Run checks
                  </button>
                ) : null}
              </div>
            </div>
          </section>
          <aside className="workspace-auxiliary" aria-label="Workspace tools">
            <div className="workspace-ai" id="workspace-ai" tabIndex={-1}>
              <CandidateAiPanel
                token={token}
                sessionStatus={session.status}
                aiCapability={session.aiCapability}
                activeFilePath={activeFilePath ?? ''}
                workspaceFiles={displayedFiles}
                canUseAi={projection.capabilities.canUseAi}
                unavailableMessage={
                  projection.uxState === 'TIME_LIMIT_REACHED'
                    ? 'The assessment time limit has been reached. AI is unavailable.'
                    : undefined
                }
              />
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
};
