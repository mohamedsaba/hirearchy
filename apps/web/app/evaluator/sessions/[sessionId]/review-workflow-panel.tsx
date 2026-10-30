'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  Clarification,
  ReviewNextStep,
  ReviewWorkflow,
} from '../../../../src/review-workflow/reviewer-workflow-store';
import './task-review.css';

const endpoint = (sessionId: string) =>
  `/api/evaluator/sessions/${encodeURIComponent(sessionId)}/review-workflow`;
const nextStepLabels: Record<ReviewNextStep['action'], string> = {
  continue_review: 'Continue this review',
  technical_review: 'Ask for a technical review',
  candidate_conversation: 'Discuss the work with the candidate',
  closeout: 'Record reviewer closeout',
};

type ReviewDraft = Readonly<{
  note?: Readonly<{ body: string; version: number }>;
  prompt?: Readonly<{ body: string; requestKey: string }>;
  nextStep?: Readonly<{
    action: ReviewNextStep['action'];
    note: string;
    version: number;
  }>;
}>;

const draftKey = (sessionId: string) => `hirearchy-review-draft:${sessionId}`;

const readDraft = (sessionId: string): ReviewDraft | null => {
  try {
    const raw = sessionStorage.getItem(draftKey(sessionId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const draft = value as Partial<ReviewDraft>;
    const validVersion = (version: unknown) =>
      typeof version === 'number' &&
      Number.isSafeInteger(version) &&
      version >= 0;
    if (
      draft.note &&
      (typeof draft.note.body !== 'string' ||
        draft.note.body.length > 4000 ||
        !validVersion(draft.note.version))
    )
      return null;
    if (
      draft.prompt &&
      (typeof draft.prompt.body !== 'string' ||
        draft.prompt.body.length > 1600 ||
        typeof draft.prompt.requestKey !== 'string' ||
        draft.prompt.requestKey.length > 128)
    )
      return null;
    if (
      draft.nextStep &&
      (!Object.hasOwn(nextStepLabels, draft.nextStep.action) ||
        typeof draft.nextStep.note !== 'string' ||
        draft.nextStep.note.length > 2000 ||
        !validVersion(draft.nextStep.version))
    )
      return null;
    return draft;
  } catch {
    return null;
  }
};

type ReadState = 'loading' | 'error' | 'ready';
type NoteSaveState = 'idle' | 'saving' | 'error';

const readFailureMessage =
  'Review notes and follow-up could not be loaded. Recorded session evidence is unchanged.';

const readWorkflow = async (sessionId: string) => {
  const response = await fetch(endpoint(sessionId), { cache: 'no-store' });
  if (!response.ok) throw new Error(readFailureMessage);
  return (await response.json()) as ReviewWorkflow;
};

export const ReviewWorkflowPanel = ({
  sessionId,
  mode = 'full',
}: {
  sessionId: string;
  mode?: 'quick-note' | 'full';
}) => {
  const isQuickNote = mode === 'quick-note';
  const [workflow, setWorkflow] = useState<ReviewWorkflow | null>(null);
  const [note, setNote] = useState('');
  const [noteVersion, setNoteVersion] = useState(0);
  const [noteConflict, setNoteConflict] = useState<NonNullable<
    ReviewWorkflow['note']
  > | null>(null);
  const [prompt, setPrompt] = useState('');
  const [requestKey, setRequestKey] = useState('');
  const [step, setStep] = useState<ReviewNextStep['action']>('continue_review');
  const [stepNote, setStepNote] = useState('');
  const [stepVersion, setStepVersion] = useState(0);
  const [stepConflict, setStepConflict] = useState<{
    current: ReviewNextStep | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [readState, setReadState] = useState<ReadState>('loading');
  const [noteSaveState, setNoteSaveState] = useState<NoteSaveState>('idle');
  const [readError, setReadError] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState(sessionId);
  const [, setSessionGeneration] = useState(0);
  const readToken = useRef(0);
  const sessionGenerationRef = useRef(0);
  const activeRetryOp = useRef(0);
  const mounted = useRef(true);
  const currentSessionRef = useRef(sessionId);

  if (sessionId !== activeSessionId) {
    setActiveSessionId(sessionId);
    setSessionGeneration((g) => {
      const next = g + 1;
      sessionGenerationRef.current = next;
      return next;
    });
    setRetrying(false);
    setRefreshing(false);
    setWorkflow(null);
    setNoteConflict(null);
    setNote('');
    setNoteVersion(0);
    setNoteSaveState('idle');
    setPrompt('');
    setRequestKey('');
    setStep('continue_review');
    setStepNote('');
    setStepVersion(0);
    setStepConflict(null);
    setBusy(false);
    setError('');
    setStatus('');
    setReadState('loading');
    setReadError('');
  }

  const loaded = readState === 'ready';

  const load = async (
    preserveDraft = false,
    targetSessionId = sessionId,
    expectedGeneration = sessionGenerationRef.current,
  ) => {
    const token = ++readToken.current;
    const value = await readWorkflow(targetSessionId);
    if (
      !mounted.current ||
      currentSessionRef.current !== targetSessionId ||
      sessionGenerationRef.current !== expectedGeneration ||
      token !== readToken.current
    )
      return;
    setWorkflow(value);
    if (!preserveDraft) {
      setNote(value.note?.body ?? '');
      setNoteVersion(value.note?.version ?? 0);
      setStep(value.nextStep?.action ?? 'continue_review');
      setStepNote(value.nextStep?.note ?? '');
      setStepVersion(value.nextStep?.version ?? 0);
      setStepConflict(null);
    }
  };

  const retryRead = async () => {
    const targetSessionId = sessionId;
    const targetGeneration = sessionGenerationRef.current;
    const opId = ++activeRetryOp.current;
    const token = ++readToken.current;
    setRetrying(true);
    try {
      const value = await readWorkflow(targetSessionId);
      if (
        !mounted.current ||
        currentSessionRef.current !== targetSessionId ||
        sessionGenerationRef.current !== targetGeneration ||
        token !== readToken.current
      )
        return;
      setWorkflow(value);
      const draft = readDraft(targetSessionId);
      setNote(draft?.note?.body ?? value.note?.body ?? '');
      setNoteVersion(draft?.note?.version ?? value.note?.version ?? 0);
      setStep(
        draft?.nextStep?.action ?? value.nextStep?.action ?? 'continue_review',
      );
      setStepNote(draft?.nextStep?.note ?? value.nextStep?.note ?? '');
      setStepVersion(draft?.nextStep?.version ?? value.nextStep?.version ?? 0);
      setPrompt(draft?.prompt?.body ?? '');
      setRequestKey(draft?.prompt?.requestKey ?? '');
      setStepConflict(null);
      setReadError('');
      setReadState('ready');
    } catch (reason: unknown) {
      if (
        !mounted.current ||
        currentSessionRef.current !== targetSessionId ||
        sessionGenerationRef.current !== targetGeneration ||
        token !== readToken.current
      )
        return;
      setReadState('error');
      setReadError(
        reason instanceof Error ? reason.message : readFailureMessage,
      );
    } finally {
      if (
        mounted.current &&
        currentSessionRef.current === targetSessionId &&
        sessionGenerationRef.current === targetGeneration &&
        activeRetryOp.current === opId
      ) {
        setRetrying(false);
      }
    }
  };

  const refreshWorkflow = async () => {
    if (refreshing) return;
    const targetSessionId = sessionId;
    const targetGeneration = sessionGenerationRef.current;
    setRefreshing(true);
    setError('');
    setStatus('');
    try {
      await load(true, targetSessionId, targetGeneration);
      if (
        !mounted.current ||
        currentSessionRef.current !== targetSessionId ||
        sessionGenerationRef.current !== targetGeneration
      )
        return;
      setStatus('Review follow-up refreshed.');
    } catch {
      if (
        !mounted.current ||
        currentSessionRef.current !== targetSessionId ||
        sessionGenerationRef.current !== targetGeneration
      )
        return;
      setError(
        'Review follow-up could not be refreshed. Your drafts are still here.',
      );
    } finally {
      if (
        mounted.current &&
        currentSessionRef.current === targetSessionId &&
        sessionGenerationRef.current === targetGeneration
      )
        setRefreshing(false);
    }
  };

  useEffect(() => {
    currentSessionRef.current = sessionId;
    mounted.current = true;
    let alive = true;
    const targetSessionId = sessionId;
    const targetGeneration = sessionGenerationRef.current;
    const token = ++readToken.current;
    void readWorkflow(targetSessionId)
      .then((value) => {
        if (
          !alive ||
          !mounted.current ||
          currentSessionRef.current !== targetSessionId ||
          sessionGenerationRef.current !== targetGeneration ||
          token !== readToken.current
        )
          return;
        setWorkflow(value);
        const draft = readDraft(targetSessionId);
        setNote(draft?.note?.body ?? value.note?.body ?? '');
        setNoteVersion(draft?.note?.version ?? value.note?.version ?? 0);
        setStep(
          draft?.nextStep?.action ??
            value.nextStep?.action ??
            'continue_review',
        );
        setStepNote(draft?.nextStep?.note ?? value.nextStep?.note ?? '');
        setStepVersion(
          draft?.nextStep?.version ?? value.nextStep?.version ?? 0,
        );
        setPrompt(draft?.prompt?.body ?? '');
        setRequestKey(draft?.prompt?.requestKey ?? '');
        setStepConflict(null);
        setReadError('');
        setReadState('ready');
      })
      .catch((reason: unknown) => {
        if (
          !alive ||
          !mounted.current ||
          currentSessionRef.current !== targetSessionId ||
          sessionGenerationRef.current !== targetGeneration ||
          token !== readToken.current
        )
          return;
        setWorkflow(null);
        setReadState('error');
        setReadError(
          reason instanceof Error ? reason.message : readFailureMessage,
        );
      });
    return () => {
      alive = false;
      readToken.current += 1;
    };
  }, [sessionId]);

  useEffect(() => {
    if (readState !== 'ready' || activeSessionId !== sessionId || !workflow)
      return;
    const draft: ReviewDraft = {
      ...(note !== (workflow.note?.body ?? '')
        ? { note: { body: note, version: noteVersion } }
        : {}),
      ...(prompt ? { prompt: { body: prompt, requestKey } } : {}),
      ...(step !== (workflow.nextStep?.action ?? 'continue_review') ||
      stepNote !== (workflow.nextStep?.note ?? '')
        ? { nextStep: { action: step, note: stepNote, version: stepVersion } }
        : {}),
    };
    try {
      if (Object.keys(draft).length)
        sessionStorage.setItem(draftKey(sessionId), JSON.stringify(draft));
      else sessionStorage.removeItem(draftKey(sessionId));
    } catch {
      // Draft persistence is best-effort when browser storage is unavailable.
    }
  }, [
    activeSessionId,
    note,
    noteVersion,
    prompt,
    readState,
    requestKey,
    sessionId,
    step,
    stepNote,
    stepVersion,
    workflow,
  ]);

  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  const post = async (
    targetSessionId: string,
    payload: Record<string, unknown>,
  ) => {
    const response = await fetch(endpoint(targetSessionId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
      note?: ReviewWorkflow['note'];
      clarification?: Clarification;
      nextStep?: ReviewNextStep;
      workflow?: ReviewWorkflow;
    };
    if (!response.ok) {
      const error = new Error(
        body?.error?.message ?? 'Your change could not be saved.',
      ) as Error & { code?: string };
      error.code = (body as { error?: { code?: string } } | null)?.error?.code;
      throw error;
    }
    return body;
  };

  const loadWorkflowConflict = async (
    targetSessionId = sessionId,
    expectedGeneration = sessionGenerationRef.current,
  ): Promise<ReviewWorkflow | null> => {
    const token = ++readToken.current;
    const value = await readWorkflow(targetSessionId).catch(() => {
      throw new Error(
        'The saved review workflow could not be reloaded. Your draft is still here.',
      );
    });
    if (
      !mounted.current ||
      currentSessionRef.current !== targetSessionId ||
      sessionGenerationRef.current !== expectedGeneration ||
      token !== readToken.current
    )
      return null;
    setWorkflow(value);
    return value;
  };

  const submit = async (
    action: (targetSessionId: string, generation: number) => Promise<void>,
  ) => {
    const targetSessionId = sessionId;
    const targetGeneration = sessionGenerationRef.current;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await action(targetSessionId, targetGeneration);
    } catch (reason) {
      if (
        !mounted.current ||
        currentSessionRef.current !== targetSessionId ||
        sessionGenerationRef.current !== targetGeneration
      )
        return;
      const conflictCode =
        reason instanceof Error && 'code' in reason ? reason.code : null;
      setNoteSaveState((current) => (current === 'saving' ? 'error' : current));
      if (
        conflictCode === 'NOTE_CHANGED' ||
        conflictCode === 'NEXT_STEP_CHANGED'
      ) {
        try {
          const value = await loadWorkflowConflict(
            targetSessionId,
            targetGeneration,
          );
          if (
            !value ||
            !mounted.current ||
            currentSessionRef.current !== targetSessionId ||
            sessionGenerationRef.current !== targetGeneration
          )
            return;
          if (conflictCode === 'NOTE_CHANGED') {
            setNoteConflict(value.note);
            setError(
              'The saved note changed while you were editing. Your draft is preserved below.',
            );
          } else {
            setStepConflict({ current: value.nextStep });
            setError(
              'The saved next step changed while you were editing. Your draft is preserved below.',
            );
          }
        } catch (reloadReason) {
          if (
            !mounted.current ||
            currentSessionRef.current !== targetSessionId ||
            sessionGenerationRef.current !== targetGeneration
          )
            return;
          setError(
            reloadReason instanceof Error
              ? reloadReason.message
              : conflictCode === 'NOTE_CHANGED'
                ? 'The saved note changed. Your draft is preserved; reload the saved version to resolve the conflict.'
                : 'The saved next step changed. Your draft is preserved; reload the saved version to resolve the conflict.',
          );
        }
        return;
      }
      setError(
        reason instanceof Error
          ? reason.message
          : 'Your change could not be saved.',
      );
    } finally {
      if (
        mounted.current &&
        currentSessionRef.current === targetSessionId &&
        sessionGenerationRef.current === targetGeneration
      ) {
        setBusy(false);
      }
    }
  };

  const savedNoteBody = workflow?.note?.body ?? '';
  const pendingClarifications =
    workflow?.clarifications.filter((item) => !item.reply && !item.closedAt)
      .length ?? 0;
  const repliedClarifications =
    workflow?.clarifications.filter((item) => item.reply && !item.closedAt)
      .length ?? 0;
  const clarificationSummary = workflow
    ? workflow.clarifications.length === 0
      ? 'No clarification requested.'
      : [
          `${workflow.clarifications.length} request${workflow.clarifications.length === 1 ? '' : 's'}`,
          pendingClarifications
            ? `${pendingClarifications} awaiting reply`
            : null,
          repliedClarifications
            ? `${repliedClarifications} reply to close`
            : null,
        ]
          .filter((value): value is string => value !== null)
          .join(' · ')
    : '';
  const noteState =
    readState === 'loading'
      ? { label: 'Loading saved note…', state: 'loading' }
      : readState === 'error'
        ? { label: 'Saved note unavailable', state: 'error' }
        : noteConflict
          ? { label: 'Conflict · your draft is preserved', state: 'conflict' }
          : noteSaveState === 'saving'
            ? { label: 'Saving note…', state: 'saving' }
            : noteSaveState === 'error'
              ? { label: 'Could not save · draft retained', state: 'error' }
              : note !== savedNoteBody
                ? { label: 'Draft · unsaved', state: 'draft' }
                : workflow?.note
                  ? {
                      label: `Saved · ${new Date(workflow.note.updatedAt).toLocaleString()}`,
                      state: 'saved',
                    }
                  : { label: 'No note saved yet', state: 'empty' };

  return (
    <section
      className={`review-section software-product reviewer-workflow-panel${isQuickNote ? ' reviewer-workflow-panel-quick' : ''}`}
      aria-labelledby="review-workflow-title"
      aria-describedby="review-workflow-guidance"
      id="reviewer-notes"
    >
      <h2 id="review-workflow-title">
        {isQuickNote ? 'Quick note' : 'Your review'}
      </h2>
      <p className="review-workflow-intro" id="review-workflow-guidance">
        {isQuickNote
          ? 'Record a human note about this session. Save keeps the existing conflict safeguards.'
          : 'Record a human-authored note for this review.'}
      </p>
      {error ? (
        <p className="review-workflow-error" role="alert">
          {error}
        </p>
      ) : null}
      {readState === 'error' ? (
        <div>
          <p className="review-workflow-error" role="alert">
            {readError}
          </p>
          <button
            id="review-workflow-retry"
            type="button"
            className="button button-secondary"
            disabled={retrying}
            aria-busy={retrying}
            onClick={() => void retryRead()}
          >
            {retrying ? 'Retrying…' : 'Retry loading review notes'}
          </button>
        </div>
      ) : null}
      {status ? (
        <p className="review-workflow-status" role="status">
          {status}
        </p>
      ) : null}
      <div
        className={`review-workflow-grid${isQuickNote ? ' review-workflow-grid-quick' : ''}`}
      >
        <section
          className="review-workflow-card"
          aria-labelledby="reviewer-note-title"
        >
          <h3 id="reviewer-note-title">Reviewer note</h3>
          <p
            className="review-note-state"
            role="status"
            aria-live="polite"
            data-note-state={noteState.state}
          >
            {noteState.label}
          </p>
          <label className="visually-hidden" htmlFor="reviewer-note-body">
            Review note
          </label>
          <textarea
            id="reviewer-note-body"
            maxLength={4000}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
              setNoteSaveState((current) =>
                current === 'saving' ? current : 'idle',
              );
            }}
            placeholder="Add a note about this work…"
            rows={4}
            disabled={!loaded}
          />
          <div className="review-workflow-controls review-note-controls">
            <span>{note.length}/4,000</span>
            <button
              type="button"
              id="save-review-note"
              disabled={busy || !loaded}
              onClick={() => {
                setNoteSaveState('saving');
                void submit(async (targetSessionId, generation) => {
                  const result = await post(targetSessionId, {
                    action: 'save_note',
                    body: note,
                    expectedVersion: noteVersion,
                  });
                  if (
                    !mounted.current ||
                    currentSessionRef.current !== targetSessionId ||
                    sessionGenerationRef.current !== generation
                  )
                    return;
                  if (!result.note)
                    throw new Error(
                      'The note save was not confirmed. Your draft is still here.',
                    );
                  setNoteVersion(result.note.version);
                  setWorkflow((current) =>
                    current
                      ? { ...current, note: result.note ?? null }
                      : current,
                  );
                  setNoteSaveState('idle');
                  setStatus('Note saved for this review.');
                });
              }}
            >
              Save decision note
            </button>
          </div>
          {noteConflict ? (
            <div
              className="review-note-conflict"
              role="group"
              aria-label="Resolve saved note conflict"
            >
              <p>
                The saved note changed while you were editing. Your draft is
                preserved. Choose which version to keep.
              </p>
              <blockquote>
                {noteConflict.body || 'The saved note is blank.'}
              </blockquote>
              <div className="review-note-conflict-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setNote(noteConflict.body);
                    setNoteVersion(noteConflict.version);
                    setNoteConflict(null);
                    setNoteSaveState('idle');
                    setError('');
                  }}
                >
                  Use saved note
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setNoteVersion(noteConflict.version);
                    setNoteConflict(null);
                    setNoteSaveState('idle');
                    setError('');
                  }}
                >
                  Keep my draft and replace saved version
                </button>
              </div>
            </div>
          ) : null}
        </section>

        {!isQuickNote ? (
          <button
            type="button"
            className="button button-secondary"
            disabled={!loaded || busy}
            aria-busy={refreshing}
            onClick={() => void refreshWorkflow()}
          >
            {refreshing ? 'Checking…' : 'Check for candidate reply'}
          </button>
        ) : null}

        {!isQuickNote ? (
          <details className="review-workflow-secondary">
            <summary>
              Request clarification
              <span className="review-workflow-summary-state">
                {clarificationSummary}
              </span>
            </summary>
            <section
              className="review-workflow-card"
              aria-labelledby="clarification-title"
            >
              <h3 id="clarification-title">Candidate clarification</h3>
              <p>
                Ask about submitted work. Candidate replies stay separate from
                recorded work.
              </p>
              <label htmlFor="clarification-prompt">Question</label>
              <textarea
                id="clarification-prompt"
                maxLength={1600}
                value={prompt}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  setRequestKey('');
                }}
                rows={4}
                placeholder="What would you like the candidate to clarify?"
                disabled={!loaded}
              />
              <div className="review-workflow-controls">
                <span>{prompt.length}/1,600</span>
                <button
                  type="button"
                  disabled={busy || !loaded || !prompt.trim()}
                  onClick={() =>
                    void submit(async (targetSessionId, generation) => {
                      const stableKey = requestKey || crypto.randomUUID();
                      setRequestKey(stableKey);
                      const result = await post(targetSessionId, {
                        action: 'request_clarification',
                        prompt,
                        requestKey: stableKey,
                      });
                      if (
                        !mounted.current ||
                        currentSessionRef.current !== targetSessionId ||
                        sessionGenerationRef.current !== generation
                      )
                        return;
                      if (!result.clarification)
                        throw new Error(
                          'The request was not confirmed. Your question is still here.',
                        );
                      setPrompt('');
                      setRequestKey('');
                      await load(true, targetSessionId, generation);
                      if (
                        !mounted.current ||
                        currentSessionRef.current !== targetSessionId ||
                        sessionGenerationRef.current !== generation
                      )
                        return;
                      setStatus(
                        'Clarification request recorded on the candidate session. No email was sent.',
                      );
                    })
                  }
                >
                  Request clarification
                </button>
              </div>
              {loaded ? (
                <ul
                  className="review-clarification-list"
                  aria-label="Clarification requests"
                >
                  {workflow?.clarifications.map((item) => (
                    <li key={item.id}>
                      <blockquote>{item.prompt}</blockquote>
                      <p className="review-workflow-meta">
                        {item.reply
                          ? 'Candidate replied'
                          : item.closedAt
                            ? 'Request closed'
                            : 'Waiting for candidate response'}
                      </p>
                      {item.reply ? (
                        <p className="review-candidate-reply">
                          <strong>
                            Candidate reply · not independently verified
                          </strong>
                          <br />
                          {item.reply}
                        </p>
                      ) : null}
                      {!item.closedAt ? (
                        <button
                          type="button"
                          disabled={busy || !item.reply}
                          onClick={() =>
                            void submit(async (targetSessionId, generation) => {
                              await post(targetSessionId, {
                                action: 'close_clarification',
                                id: item.id,
                              });
                              if (
                                !mounted.current ||
                                currentSessionRef.current !== targetSessionId ||
                                sessionGenerationRef.current !== generation
                              )
                                return;
                              await load(true, targetSessionId, generation);
                              if (
                                !mounted.current ||
                                currentSessionRef.current !== targetSessionId ||
                                sessionGenerationRef.current !== generation
                              )
                                return;
                              setStatus('Clarification closed.');
                            })
                          }
                        >
                          Close request
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {workflow?.clarifications.some(
                (item) => !item.reply && !item.closedAt,
              ) ? (
                <p className="review-workflow-meta">
                  An unanswered request stays open. Record a next step
                  explicitly if the review is closing while it is pending.
                </p>
              ) : null}
            </section>
          </details>
        ) : null}

        {!isQuickNote ? (
          <details className="review-workflow-secondary">
            <summary>
              Human next step
              <span className="review-workflow-summary-state">
                {workflow?.nextStep
                  ? nextStepLabels[workflow.nextStep.action]
                  : workflow
                    ? 'No next step recorded.'
                    : ''}
              </span>
            </summary>
            <section
              className="review-workflow-card"
              aria-labelledby="next-step-title"
            >
              <h3 className="visually-hidden" id="next-step-title">
                Human next step
              </h3>
              <label htmlFor="review-next-step">Next step</label>
              <select
                id="review-next-step"
                value={step}
                disabled={!loaded}
                onChange={(event) =>
                  setStep(event.target.value as ReviewNextStep['action'])
                }
              >
                {Object.entries(nextStepLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <label htmlFor="review-next-step-note">Context (optional)</label>
              <textarea
                id="review-next-step-note"
                maxLength={2000}
                value={stepNote}
                disabled={!loaded}
                onChange={(event) => setStepNote(event.target.value)}
                rows={3}
              />
              <div className="review-workflow-controls">
                <span>{stepNote.length}/2,000</span>
                <button
                  type="button"
                  disabled={busy || !loaded || !workflow}
                  onClick={() =>
                    void submit(async (targetSessionId, generation) => {
                      const result = await post(targetSessionId, {
                        action: 'save_next_step',
                        step,
                        note: stepNote,
                        expectedVersion: stepVersion,
                      });
                      if (
                        !mounted.current ||
                        currentSessionRef.current !== targetSessionId ||
                        sessionGenerationRef.current !== generation
                      )
                        return;
                      if (!result.nextStep)
                        throw new Error('The next step was not confirmed.');
                      setStepVersion(result.nextStep.version);
                      setStepConflict(null);
                      setWorkflow((current) =>
                        current
                          ? { ...current, nextStep: result.nextStep ?? null }
                          : current,
                      );
                      setStatus('Human next step recorded.');
                    })
                  }
                >
                  Save next step
                </button>
              </div>
              {stepConflict ? (
                <div
                  className="review-note-conflict"
                  role="group"
                  aria-label="Resolve saved next step conflict"
                >
                  <p>
                    The saved next step changed while you were editing. Your
                    draft is preserved. Choose which version to keep.
                  </p>
                  <p>
                    Saved next step:{' '}
                    {stepConflict.current
                      ? nextStepLabels[stepConflict.current.action]
                      : 'No next step is saved.'}
                  </p>
                  {stepConflict.current?.note ? (
                    <blockquote>{stepConflict.current.note}</blockquote>
                  ) : null}
                  <div className="review-note-conflict-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setStep(
                          stepConflict.current?.action ?? 'continue_review',
                        );
                        setStepNote(stepConflict.current?.note ?? '');
                        setStepVersion(stepConflict.current?.version ?? 0);
                        setStepConflict(null);
                        setError('');
                      }}
                    >
                      Use saved next step
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setStepVersion(stepConflict.current?.version ?? 0);
                        setStepConflict(null);
                        setError('');
                      }}
                    >
                      Keep my draft and replace saved version
                    </button>
                  </div>
                </div>
              ) : null}
              {workflow?.nextStep ? (
                <p className="review-workflow-meta">
                  Recorded: {nextStepLabels[workflow.nextStep.action]}
                </p>
              ) : loaded && workflow ? (
                <p className="review-workflow-meta">No next step recorded.</p>
              ) : null}
            </section>
          </details>
        ) : null}
      </div>
    </section>
  );
};
