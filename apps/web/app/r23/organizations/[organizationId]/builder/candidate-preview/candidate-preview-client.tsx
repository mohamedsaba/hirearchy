'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import {
  IconArrowLeft,
  IconCheck,
  IconClock,
  IconEye,
  IconFileCode,
  IconMessageCode,
  IconPlayerPlay,
  IconRefresh,
  IconShieldCheck,
} from '@tabler/icons-react';

import type {
  PlatformTemplateView,
  SavedLibraryProblem,
} from '../../../../../../src/hiring/types';
import type { R211AssessmentDraftInput } from '../../../../../../src/r211-builder/contract';
import { readPersistedJson } from '../../../../../../src/ui/browser-state';
import { ScenarioBrief } from '../../../../../../src/ui/scenario-brief';
import { CommonThreadLoader } from '../../../../../_components/common-thread-loader';
import { markOrgActivationFlag } from '../../../../_components/org-activation-checklist';
import { useHirearchyTheme } from '../../../../../_components/theme-toggle';

const CodeEditorSurface = dynamic(
  () =>
    import('../../../../../r26/candidate/[sessionId]/code-editor-surface').then(
      (m) => m.CodeEditorSurface,
    ),
  {
    ssr: false,
    loading: () => (
      <div style={{ padding: '1rem' }}>
        <CommonThreadLoader compact label="Loading code editor…" />
      </div>
    ),
  },
);

export const CANDIDATE_PREVIEW_DRAFT_KEY_PREFIX =
  'hirearchy:candidate-preview:draft:v1:';

type PreviewStage = 'prestart' | 'workspace' | 'submitted';

function toDraftFromProblem(
  problem: SavedLibraryProblem,
): R211AssessmentDraftInput {
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

function readStoredBuilderDraft(
  organizationId: string,
  draftId?: string,
): R211AssessmentDraftInput | null {
  if (typeof window === 'undefined') return null;

  const directPreview = readPersistedJson<{ draft?: R211AssessmentDraftInput }>(
    `${CANDIDATE_PREVIEW_DRAFT_KEY_PREFIX}${organizationId}`,
    'session',
  );
  if (directPreview?.draft && Array.isArray(directPreview.draft.starterFiles)) {
    return directPreview.draft;
  }

  if (draftId) {
    if (draftId === 'legacy') {
      const legacy = readPersistedJson<{ draft?: R211AssessmentDraftInput }>(
        `hirearchy:builder:state:v2:${organizationId}`,
        'durable',
      );
      if (legacy?.draft && Array.isArray(legacy.draft.starterFiles)) {
        return legacy.draft;
      }
    }
    const prefix = `hirearchy:builder:draft:${organizationId}:`;
    for (const storage of [window.sessionStorage, window.localStorage]) {
      for (const key of Object.keys(storage)) {
        if (key.startsWith(prefix) && key.endsWith(`:${draftId}`)) {
          try {
            const parsed = JSON.parse(storage.getItem(key) ?? 'null') as {
              draft?: R211AssessmentDraftInput;
            } | null;
            if (parsed?.draft && Array.isArray(parsed.draft.starterFiles)) {
              return parsed.draft;
            }
          } catch {
            // Ignore malformed stored draft.
          }
        }
      }
    }
  }

  return null;
}

export function CandidatePreviewClient({
  organizationId,
  organizationName,
  initialTemplates,
  draftId,
  templateId,
  matchedProblem,
}: {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly initialTemplates: readonly PlatformTemplateView[];
  readonly draftId?: string;
  readonly templateId?: string;
  readonly matchedProblem?: SavedLibraryProblem | null;
}) {
  const theme = useHirearchyTheme();
  const orgBase = `/r23/organizations/${encodeURIComponent(organizationId)}`;
  const fallbackDraft: R211AssessmentDraftInput = useMemo(() => {
    if (matchedProblem) return toDraftFromProblem(matchedProblem);
    const tpl =
      (templateId
        ? initialTemplates.find((item) => item.templateId === templateId)
        : undefined) ?? initialTemplates[0];
    return tpl.baseDraft;
  }, [initialTemplates, matchedProblem, templateId]);

  const [draft, setDraft] = useState<R211AssessmentDraftInput>(fallbackDraft);
  const [stage, setStage] = useState<PreviewStage>('prestart');
  const [activePath, setActivePath] = useState<string>(
    fallbackDraft.primaryFilePath || fallbackDraft.starterFiles[0]?.path || '',
  );
  const [filesMap, setFilesMap] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fallbackDraft.starterFiles.map((file) => [file.path, file.content]),
    ),
  );
  const [remainingSeconds, setRemainingSeconds] = useState<number>(
    fallbackDraft.durationMinutes * 60,
  );
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiLog, setAiLog] = useState<
    Array<{ role: 'candidate' | 'assistant'; text: string }>
  >([]);

  useEffect(() => {
    markOrgActivationFlag(organizationId, 'previewVisited');
  }, [organizationId]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const stored = readStoredBuilderDraft(organizationId, draftId);
      if (stored && stored.starterFiles.length > 0) {
        setDraft(stored);
        setActivePath(stored.primaryFilePath || stored.starterFiles[0].path);
        setFilesMap(
          Object.fromEntries(
            stored.starterFiles.map((file) => [file.path, file.content]),
          ),
        );
        setRemainingSeconds(stored.durationMinutes * 60);
      }
    });
    return () => {
      active = false;
    };
  }, [organizationId, draftId]);

  useEffect(() => {
    if (stage !== 'workspace') return;
    const timer = window.setInterval(() => {
      setRemainingSeconds((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [stage]);

  const modifiedCount = useMemo(
    () =>
      draft.starterFiles.filter(
        (file) => (filesMap[file.path] ?? file.content) !== file.content,
      ).length,
    [draft.starterFiles, filesMap],
  );

  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  const timerLabel = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  const resetPreview = () => {
    setFilesMap(
      Object.fromEntries(
        draft.starterFiles.map((file) => [file.path, file.content]),
      ),
    );
    setActivePath(draft.primaryFilePath || draft.starterFiles[0]?.path || '');
    setRemainingSeconds(draft.durationMinutes * 60);
    setAiLog([]);
    setStage('prestart');
  };

  return (
    <div
      className="hiring-page-shell candidate-preview-shell"
      data-testid="candidate-preview-shell"
    >
      <div
        className="hiring-banner candidate-preview-banner"
        role="status"
        data-testid="candidate-preview-sandbox-banner"
      >
        <div className="candidate-preview-banner-copy">
          <IconEye size={17} aria-hidden="true" />
          <span>
            <strong>Preview as Candidate (Sandbox)</strong> — Zero credits
            consumed, no session created, and edits remain strictly in local
            browser memory.
          </span>
        </div>
        <div className="hiring-header-actions">
          <button
            type="button"
            className="hiring-btn hiring-btn-sm"
            onClick={resetPreview}
          >
            <IconRefresh size={14} aria-hidden="true" /> Reset preview
          </button>
          <Link
            className="hiring-btn hiring-btn-sm"
            href={`${orgBase}/builder${draftId ? `?draft=${encodeURIComponent(draftId)}` : ''}`}
          >
            <IconArrowLeft size={14} aria-hidden="true" /> Back to builder
          </Link>
        </div>
      </div>

      {stage === 'prestart' ? (
        <section
          className="hiring-card candidate-preview-prestart"
          aria-labelledby="preview-prestart-title"
        >
          <span className="hiring-eyebrow">
            {organizationName} · Pre-start consent &amp; task brief
          </span>
          <h1 id="preview-prestart-title">{draft.title}</h1>
          <p className="hiring-muted-copy">
            This is the exact pre-start screen candidates see before clicking
            Start. Their timer does not begin until they activate the workspace.
          </p>

          <div className="candidate-preview-facts">
            <div className="hiring-card-subtle">
              <strong>Time budget</strong>
              <p>{draft.durationMinutes} minutes (starts only on Start)</p>
            </div>
            <div className="hiring-card-subtle">
              <strong>AI assistant policy</strong>
              <p>
                {draft.integratedAi
                  ? 'Enabled — workspace prompts are logged neutrally for context'
                  : 'Disabled for this assessment'}
              </p>
            </div>
            <div className="hiring-card-subtle">
              <strong>Repository scope</strong>
              <p>
                {draft.starterFiles.length}{' '}
                {draft.starterFiles.length === 1 ? 'file' : 'files'} · Real
                editor, zero trick puzzles
              </p>
            </div>
          </div>

          <div className="hiring-card-subtle candidate-preview-promise">
            <div className="candidate-preview-promise-head">
              <IconShieldCheck size={18} aria-hidden="true" />
              <strong>Candidate Respect Standard (candidate-data-v1)</strong>
            </div>
            <ul className="hiring-bullet-list">
              <li>
                Zero webcam recording, zero microphone capture, and zero desktop
                lockdown software.
              </li>
              <li>
                Only saved file revisions, workspace runs, and your final
                submission are shared with the hiring team.
              </li>
              <li>
                You keep a permanent read-only copy of your submitted code after
                submission.
              </li>
            </ul>
          </div>

          <div className="hiring-header-actions">
            <button
              type="button"
              className="hiring-btn hiring-btn-primary"
              onClick={() => setStage('workspace')}
            >
              <IconPlayerPlay size={16} aria-hidden="true" /> Start preview
              assessment
            </button>
          </div>
        </section>
      ) : null}

      {stage === 'workspace' ? (
        <section
          className="candidate-preview-workspace"
          aria-label="Simulated candidate IDE"
        >
          <header className="hiring-card candidate-preview-ide-bar">
            <div>
              <strong>{draft.title}</strong>
              <p className="hiring-muted-copy">
                Simulated candidate session ·{' '}
                {modifiedCount === 0
                  ? 'No local edits yet'
                  : `${modifiedCount} ${modifiedCount === 1 ? 'file' : 'files'} modified locally`}
              </p>
            </div>
            <div className="hiring-header-actions">
              <span className="hiring-pill hiring-pill-plum">
                <IconClock size={14} aria-hidden="true" /> {timerLabel}
              </span>
              <button
                type="button"
                className="hiring-btn hiring-btn-primary"
                onClick={() => setStage('submitted')}
              >
                <IconCheck size={15} aria-hidden="true" /> Submit preview
              </button>
            </div>
          </header>

          <div className="candidate-preview-grid">
            <aside className="hiring-card candidate-preview-sidebar">
              <h2>Task brief</h2>
              <ScenarioBrief markdown={draft.brief} />
              {draft.acceptanceCriteria.length > 0 ? (
                <div className="hiring-card-subtle">
                  <strong>Acceptance criteria</strong>
                  <ul className="hiring-bullet-list">
                    {draft.acceptanceCriteria.map((criterion) => (
                      <li key={criterion}>{criterion}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <h3>Files</h3>
              <ul className="candidate-preview-files">
                {draft.starterFiles.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      className={`software-repo-file${activePath === file.path ? ' is-active' : ''}`}
                      aria-current={
                        activePath === file.path ? 'true' : undefined
                      }
                      onClick={() => setActivePath(file.path)}
                    >
                      <IconFileCode size={15} aria-hidden="true" />
                      <span>{file.path}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </aside>

            <div className="hiring-card candidate-preview-editor-card">
              <div className="candidate-preview-editor-head">
                <code>{activePath}</code>
                <span className="hiring-pill">Editable sandbox</span>
              </div>
              <div className="candidate-preview-editor">
                <CodeEditorSurface
                  path={activePath}
                  value={filesMap[activePath] ?? ''}
                  theme={theme}
                  editable={true}
                  readOnly={false}
                  lineWrap={true}
                  fontSizePx={14}
                  onChange={(nextValue) =>
                    setFilesMap((prev) => ({
                      ...prev,
                      [activePath]: nextValue,
                    }))
                  }
                />
              </div>

              {draft.integratedAi ? (
                <div className="hiring-card-subtle candidate-preview-ai-box">
                  <div className="candidate-preview-promise-head">
                    <IconMessageCode size={16} aria-hidden="true" />
                    <strong>
                      Workspace AI Assistant (simulated — neutral logging on)
                    </strong>
                  </div>
                  <form
                    className="candidate-preview-ai-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const q = aiPrompt.trim();
                      if (!q) return;
                      setAiLog((prev) => [
                        ...prev,
                        { role: 'candidate', text: q },
                        {
                          role: 'assistant',
                          text: `Preview response: In a live session, prompts like "${q}" are answered using your sandbox context and logged neutrally without penalty.`,
                        },
                      ]);
                      setAiPrompt('');
                    }}
                  >
                    <input
                      type="text"
                      placeholder="Test a candidate AI prompt in preview…"
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                    />
                    <button type="submit" className="hiring-btn hiring-btn-sm">
                      Ask AI
                    </button>
                  </form>
                  {aiLog.length > 0 ? (
                    <div className="candidate-preview-ai-log">
                      {aiLog.map((entry, idx) => (
                        <p key={idx} className="hiring-muted-copy">
                          <strong>
                            {entry.role === 'candidate'
                              ? 'Candidate:'
                              : 'AI Assistant:'}
                          </strong>{' '}
                          {entry.text}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {stage === 'submitted' ? (
        <section
          className="hiring-card"
          aria-labelledby="preview-submitted-title"
          data-testid="candidate-preview-submitted-banner"
        >
          <div className="hiring-banner hiring-banner-success" role="status">
            <span>
              <strong>Simulated Submit Preview complete.</strong> No database
              session was created and zero candidate credits were consumed.
            </span>
          </div>
          <h1 id="preview-submitted-title" className="hiring-mt-sm">
            What your candidate sees after submitting
          </h1>
          <p className="hiring-muted-copy">
            Real candidates immediately receive a frozen, read-only submission
            receipt for <strong>{draft.title}</strong> ({modifiedCount} modified{' '}
            {modifiedCount === 1 ? 'file' : 'files'} in this preview) while
            human evaluators inspect diffs chronologically.
          </p>
          <div className="hiring-header-actions hiring-mt-sm">
            <button type="button" className="hiring-btn" onClick={resetPreview}>
              <IconRefresh size={15} aria-hidden="true" /> Restart preview
            </button>
            <Link
              className="hiring-btn hiring-btn-primary"
              href={`${orgBase}/builder${draftId ? `?draft=${encodeURIComponent(draftId)}` : ''}`}
            >
              Back to builder
            </Link>
          </div>
        </section>
      ) : null}
    </div>
  );
}
