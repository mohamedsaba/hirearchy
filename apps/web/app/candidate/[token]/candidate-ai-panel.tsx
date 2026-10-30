'use client';

import { useEffect, useRef, useState } from 'react';

import './candidate-ai-panel.css';

import type { SessionStatus } from '../../../src/sessions/session';
import type { CandidateAiCapability } from '../../../src/sessions/candidate-session-view';
import { MAXIMUM_AI_CONTEXT_ATTACHMENTS } from '../../../src/ai/ai-interaction';
import {
  beginSubmission,
  buildAiInteractionPayload,
  INITIAL_CANDIDATE_AI_STATE,
  MAXIMUM_PROMPT_CHARS,
  resolveSubmissionNetworkError,
  resolveSubmissionResult,
  retryRequest,
  setPromptText,
  startNewRequest,
  type CandidateAiState,
  type ServerInteractionResponse,
} from './candidate-ai-state';

export type CandidateWorkspaceFile = Readonly<{
  path: string;
  isDirectory: boolean;
}>;

export type CandidateAiPanelProps = Readonly<{
  token: string;
  sessionStatus: SessionStatus;
  aiCapability: CandidateAiCapability | null;
  activeFilePath?: string;
  workspaceFiles?: readonly CandidateWorkspaceFile[];
  canUseAi?: boolean;
  unavailableMessage?: string;
  onSubmissionChange?: (isSubmitting: boolean) => void;
  initialState?: CandidateAiState;
}>;

/* The conversation log scrolls only when the candidate is already near the
   bottom, so reading back through earlier answers is never interrupted. */
const SCROLL_RESUME_THRESHOLD_PX = 96;

export const TERMINAL_REFERENCE = '@terminal';

const inlineAnswer = (text: string) =>
  text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    .map((part, index) =>
      part.startsWith('**') ? (
        <strong key={index}>{part.slice(2, -2)}</strong>
      ) : part.startsWith('`') ? (
        <code key={index}>{part.slice(1, -1)}</code>
      ) : (
        part
      ),
    );

const isAttachablePath = (path: string): boolean => {
  const trimmed = path.trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.includes('\\'))
    return false;
  return !trimmed.split('/').some((segment) => segment === '..');
};

export const resolveAttachablePaths = (
  workspaceFiles: readonly CandidateWorkspaceFile[] | undefined,
): readonly string[] => {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const file of workspaceFiles ?? []) {
    if (!file || file.isDirectory) continue;
    if (!isAttachablePath(file.path)) continue;
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    paths.push(file.path);
  }
  return paths;
};

export const toggleAttachedPath = (
  attachments: readonly string[],
  path: string,
): readonly string[] => {
  if (attachments.includes(path)) {
    return attachments.filter((item) => item !== path);
  }
  if (attachments.length >= MAXIMUM_AI_CONTEXT_ATTACHMENTS) {
    return attachments;
  }
  return [...attachments, path];
};

export const insertTerminalReference = (prompt: string): string => {
  if (prompt.includes(TERMINAL_REFERENCE)) return prompt;
  const separator = prompt.length === 0 || /\s$/u.test(prompt) ? '' : ' ';
  return `${prompt}${separator}${TERMINAL_REFERENCE} `;
};

export const CandidateAiPanel = ({
  token,
  sessionStatus,
  aiCapability,
  activeFilePath,
  workspaceFiles,
  canUseAi = sessionStatus === 'ACTIVE',
  unavailableMessage,
  onSubmissionChange,
  initialState = INITIAL_CANDIDATE_AI_STATE,
}: CandidateAiPanelProps) => {
  const [state, setState] = useState<CandidateAiState>(initialState);
  const [attachmentSelection, setAttachments] = useState<
    readonly string[] | null
  >(null);
  const attachments =
    attachmentSelection ??
    (activeFilePath && isAttachablePath(activeFilePath)
      ? [activeFilePath]
      : []);
  const isSubmitting = state.submissionState === 'submitting';
  const conversationRef = useRef<HTMLOListElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const followConversationRef = useRef(true);

  const selectablePaths = resolveAttachablePaths(workspaceFiles);
  const context = attachments.map((filePath) => ({ filePath }));

  useEffect(() => {
    const log = conversationRef.current;
    if (!log) return;
    if (!followConversationRef.current) return;
    log.scrollTop = log.scrollHeight;
  }, [state.submissionState, state.conversation.length]);

  const focusComposer = () => {
    composerRef.current?.focus();
  };

  /* Every send after a finished request starts a new identity while the text
     the candidate just typed is preserved verbatim. */
  const prepareForSubmission = (
    previous: CandidateAiState,
  ): CandidateAiState => {
    if (
      previous.submissionState === 'idle' ||
      previous.submissionState === 'submitting'
    ) {
      return previous;
    }
    return setPromptText(startNewRequest(previous), previous.prompt);
  };

  const runSubmission = async (base: CandidateAiState) => {
    const admission = beginSubmission(base, context);
    if (!admission) return;

    setState(admission.nextState);
    onSubmissionChange?.(true);

    try {
      const response = await fetch(
        `/api/candidate/sessions/${token}/ai/interactions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            buildAiInteractionPayload(base, admission.requestId, context),
          ),
        },
      );
      const data = (await response
        .json()
        .catch(() => null)) as ServerInteractionResponse | null;
      setState((previous) => {
        const resolved = resolveSubmissionResult(
          previous,
          response.status,
          data,
        );
        return resolved.submissionState === 'completed'
          ? { ...resolved, prompt: '' }
          : resolved;
      });
    } catch {
      setState((previous) => resolveSubmissionNetworkError(previous));
    } finally {
      onSubmissionChange?.(false);
    }
  };

  const handleSubmit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!canUseAi || isSubmitting || state.submissionState === 'ambiguous')
      return;
    await runSubmission(prepareForSubmission(state));
  };

  const availabilityMessage = !aiCapability
    ? 'Integrated AI assistance is unavailable for this assessment.'
    : !aiCapability.enabled
      ? 'Integrated AI assistance is not enabled for this assessment.'
      : sessionStatus === 'CREATED'
        ? 'Start the assessment to use integrated AI assistance.'
        : sessionStatus === 'SUBMITTED'
          ? 'Assessment submitted. Integrated AI assistance is closed.'
          : (unavailableMessage ??
            'AI is unavailable while the assessment is not active.');

  const showComposer = aiCapability?.enabled && canUseAi;
  const attachmentLimitReached =
    attachments.length >= MAXIMUM_AI_CONTEXT_ATTACHMENTS;
  const sendsSavedWorkspaceContext = Boolean(
    aiCapability?.includesWorkspaceContext,
  );

  return (
    <section
      className="candidate-ai-panel weft-ai"
      aria-labelledby="ai-panel-title"
    >
      <div className="ai-panel-header weft-ai-header">
        <img src="/software/icons/sparkle.svg" alt="" aria-hidden="true" />
        <div>
          <h2 id="ai-panel-title">Weft</h2>
          <p className="weft-ai-lede">Your engineering assistant</p>
        </div>
      </div>
      {state.conversation.length === 0 && showComposer ? (
        <div className="weft-ai-empty">
          <p>
            A second perspective
            <br />
            on your work.
          </p>
          <span>Ask about a file, a failing check, or a design choice.</span>
        </div>
      ) : null}

      {state.conversation.length > 0 ? (
        <ol
          className="ai-conversation weft-ai-log"
          aria-label="AI conversation"
          onScroll={(event) => {
            const log = event.currentTarget;
            followConversationRef.current =
              log.scrollHeight - log.scrollTop - log.clientHeight <=
              SCROLL_RESUME_THRESHOLD_PX;
          }}
          ref={conversationRef}
          tabIndex={0}
        >
          {state.conversation.map((entry) => (
            <li
              className="ai-conversation-entry weft-ai-exchange"
              key={entry.requestId}
            >
              <section className="weft-ai-message weft-ai-message--you">
                <h3 className="ai-section-subtitle weft-ai-role">You</h3>
                <pre className="weft-ai-body weft-ai-body--you">
                  {entry.prompt}
                </pre>
                <p className="ai-context-summary weft-ai-context-line">
                  {entry.context.length > 0
                    ? `Sent with this message: ${entry.context.map((item) => item.filePath).join(', ')}.`
                    : 'Sent with this message: no files.'}
                </p>
              </section>

              {entry.status === 'submitting' ? (
                <section className="weft-ai-message weft-ai-message--weft">
                  <h3 className="ai-section-subtitle weft-ai-role">Weft</h3>
                  <p
                    className="ai-submitting-status weft-ai-pending"
                    role="status"
                  >
                    <span className="weft-ai-pending-mark" aria-hidden="true" />
                    Weft is preparing a response for this request.
                  </p>
                </section>
              ) : null}

              {entry.status === 'completed' ? (
                <section className="weft-ai-message weft-ai-message--weft">
                  <h3 className="ai-section-subtitle weft-ai-role">Weft</h3>
                  <div className="weft-ai-body weft-ai-body--weft">
                    {(entry.responseText ?? '')
                      .split(/^```[^\n]*\n?/m)
                      .map((part, index) =>
                        index % 2 ? (
                          <pre key={index}>
                            <code>{part}</code>
                          </pre>
                        ) : (
                          <p key={index}>{inlineAnswer(part)}</p>
                        ),
                      )}
                  </div>
                </section>
              ) : null}

              {entry.status === 'failed' || entry.status === 'ambiguous' ? (
                <p className="ai-error-text weft-ai-alert" role="alert">
                  {entry.errorMessage}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      {!showComposer ? (
        <div className="ai-notice-card weft-ai-closed" role="status">
          <p>{availabilityMessage}</p>
        </div>
      ) : null}

      {showComposer && state.submissionState === 'failed' ? (
        <div className="ai-action-row weft-ai-actions">
          <button
            className="button button-primary weft-ai-action"
            disabled={isSubmitting}
            onClick={() => {
              focusComposer();
              void runSubmission(retryRequest(state));
            }}
            type="button"
          >
            Retry request
          </button>
          <button
            className="button button-secondary weft-ai-action"
            onClick={() => {
              setState((previous) => retryRequest(previous));
              focusComposer();
            }}
            type="button"
          >
            Edit this message
          </button>
        </div>
      ) : null}

      {showComposer && state.submissionState === 'ambiguous' ? (
        <div className="ai-action-row weft-ai-actions">
          <button
            className="button button-secondary weft-ai-action"
            onClick={() => {
              setState((previous) => retryRequest(previous));
              focusComposer();
            }}
            type="button"
          >
            Dismiss and edit
          </button>
        </div>
      ) : null}

      {showComposer ? (
        <form
          className="ai-composer-form weft-ai-composer"
          onSubmit={handleSubmit}
        >
          {attachments.length > 0 ? (
            <ul className="ai-context-list weft-ai-chips">
              {attachments.map((path) => (
                <li className="ai-context-chip weft-ai-chip" key={path}>
                  <span className="weft-ai-chip-path">{path}</span>
                  <button
                    disabled={isSubmitting}
                    aria-label={`Remove ${path} from context`}
                    className="ai-context-remove weft-ai-chip-remove"
                    onClick={() =>
                      setAttachments((current) =>
                        (current ?? attachments).filter(
                          (item) => item !== path,
                        ),
                      )
                    }
                    type="button"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="weft-ai-context-note">
              Attach files below if you want Weft to read them.
            </p>
          )}

          <details className="weft-ai-context" id="candidate-ai-context">
            <summary className="weft-ai-context-summary">
              <span className="weft-ai-context-count">
                {attachments.length === 0
                  ? 'No files attached'
                  : `${attachments.length} of ${MAXIMUM_AI_CONTEXT_ATTACHMENTS} files attached`}
              </span>
              <span className="weft-ai-context-disclosure">
                What is sent with each request
              </span>
            </summary>

            <div className="weft-ai-context-body">
              <ul className="weft-ai-context-facts">
                <li>
                  {sendsSavedWorkspaceContext
                    ? 'Saved file contents and the published task brief are sent with the paths above. Unsaved editor edits are not included.'
                    : 'Only the file paths above are sent. Unsaved editor edits are not included.'}
                </li>
                <li>
                  {sendsSavedWorkspaceContext
                    ? 'Recent recorded test checks are already included: the recorded command, its exit code, and output previews captured earlier in this assessment.'
                    : 'Recorded test checks are not included in this configuration.'}
                </li>
                <li>
                  Weft provides text suggestions. You edit files and run
                  commands. Requests and responses are recorded. Assessment
                  metadata is included.
                </li>
              </ul>
            </div>
          </details>

          <div className="ai-prompt-section weft-ai-composer-body">
            <label
              className="ai-field-label weft-ai-label"
              htmlFor="candidate-ai-prompt"
            >
              Message Weft
            </label>
            <textarea
              aria-describedby="candidate-ai-context"
              className="ai-prompt-input weft-ai-input"
              disabled={isSubmitting}
              id="candidate-ai-prompt"
              maxLength={MAXIMUM_PROMPT_CHARS}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              onChange={(event) =>
                setState((previous) =>
                  setPromptText(previous, event.target.value),
                )
              }
              placeholder="Message Weft…"
              ref={composerRef}
              rows={3}
              value={state.prompt}
            />
            {state.prompt.length > 28_000 ? (
              <span className="ai-char-counter weft-ai-counter">
                {state.prompt.length.toLocaleString()} /{' '}
                {MAXIMUM_PROMPT_CHARS.toLocaleString()} characters
              </span>
            ) : null}
          </div>

          <div className="ai-composer-footer weft-ai-toolbar">
            <details
              className="weft-ai-picker"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.currentTarget.open = false;
                  event.currentTarget.querySelector('summary')?.focus();
                }
              }}
            >
              <summary className="weft-ai-picker-summary">Add files</summary>
              <fieldset
                className="weft-ai-picker-fieldset"
                disabled={isSubmitting}
              >
                <legend className="weft-ai-picker-legend">
                  Choose workspace files to include with this request.
                </legend>
                {selectablePaths.length === 0 ? (
                  <p className="weft-ai-context-note">
                    No workspace files are available to attach from this page.
                  </p>
                ) : (
                  <ul className="weft-ai-picker-list">
                    {selectablePaths.map((path, index) => {
                      const attached = attachments.includes(path);
                      const inputId = `weft-ai-file-${index}`;
                      return (
                        <li className="weft-ai-picker-option" key={path}>
                          <input
                            checked={attached}
                            disabled={!attached && attachmentLimitReached}
                            id={inputId}
                            onChange={() =>
                              setAttachments((current) =>
                                toggleAttachedPath(
                                  current ?? attachments,
                                  path,
                                ),
                              )
                            }
                            type="checkbox"
                            value={path}
                          />
                          <label
                            className="weft-ai-picker-path"
                            htmlFor={inputId}
                          >
                            {path}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {attachmentLimitReached ? (
                  <p className="weft-ai-context-note">
                    A request carries at most {MAXIMUM_AI_CONTEXT_ATTACHMENTS}{' '}
                    file paths. Remove one to choose another.
                  </p>
                ) : null}
              </fieldset>
            </details>

            <button
              className="button button-secondary weft-ai-terminal"
              disabled={
                isSubmitting ||
                !sendsSavedWorkspaceContext ||
                state.prompt.length + 11 > MAXIMUM_PROMPT_CHARS
              }
              title="Reference recent recorded test checks; Weft cannot run commands"
              onClick={() => {
                setState((previous) =>
                  setPromptText(
                    previous,
                    insertTerminalReference(previous.prompt),
                  ),
                );
                focusComposer();
              }}
              type="button"
            >
              @terminal
            </button>

            <button
              className="button button-primary ai-submit-button weft-ai-send"
              disabled={
                isSubmitting ||
                !state.prompt.trim() ||
                state.submissionState === 'ambiguous'
              }
              type="submit"
            >
              {isSubmitting ? 'Sending…' : 'Send request'}
            </button>
          </div>
        </form>
      ) : null}

      {showComposer ? (
        <p className="ai-local-notice weft-ai-local">
          Save files before attaching. History stays on this page; refreshing
          does not restore it.
        </p>
      ) : null}
    </section>
  );
};
