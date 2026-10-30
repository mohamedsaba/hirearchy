'use client';

import { useEffect, useState } from 'react';
import type { Clarification } from '../../../src/review-workflow/reviewer-workflow-store';

export const ClarificationInbox = ({ token }: { token: string }) => {
  const [items, setItems] = useState<readonly Clarification[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const endpoint = `/api/candidate/sessions/${encodeURIComponent(token)}/clarifications`;

  const load = async () => {
    const response = await fetch(endpoint, { cache: 'no-store' });
    if (!response.ok)
      throw new Error(
        'Follow-up requests could not be loaded. Reload to try again.',
      );
    const result = (await response.json()) as {
      clarifications: readonly Clarification[];
    };
    setItems(result.clarifications);
  };

  useEffect(() => {
    let alive = true;
    void fetch(endpoint, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            'Follow-up requests could not be loaded. Reload to try again.',
          );
        const result = (await response.json()) as {
          clarifications: readonly Clarification[];
        };
        if (alive) setItems(result.clarifications);
      })
      .catch((reason: unknown) => {
        if (alive)
          setError(
            reason instanceof Error
              ? reason.message
              : 'Follow-up requests are unavailable.',
          );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [endpoint]);

  const refresh = async () => {
    setError('');
    try {
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Follow-up requests are unavailable.',
      );
    }
  };

  const sendReply = async (item: Clarification) => {
    const reply = drafts[item.id]?.trim() ?? '';
    if (!reply) return;
    setBusyId(item.id);
    setError('');
    setStatus('');
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, reply }),
      });
      const result = (await response.json()) as {
        clarification?: Clarification;
        error?: { message?: string };
      };
      if (!response.ok || !result.clarification)
        throw new Error(
          result.error?.message ??
            'Your reply was not confirmed. It is still here so you can try again.',
        );
      setItems((current) =>
        current.map((value) =>
          value.id === item.id ? result.clarification! : value,
        ),
      );
      setStatus(
        'Reply recorded. Your submitted workspace remains closed and unchanged.',
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Your reply was not confirmed. It is still here so you can try again.',
      );
    } finally {
      setBusyId(null);
    }
  };

  if (loading)
    return (
      <section
        className="candidate-clarifications"
        aria-labelledby="candidate-clarifications-title"
      >
        <h2 id="candidate-clarifications-title">
          Follow-up from the evaluator
        </h2>
        <p role="status">Checking for requests…</p>
      </section>
    );

  return (
    <section
      className="candidate-clarifications"
      aria-labelledby="candidate-clarifications-title"
    >
      <div className="candidate-clarifications-heading">
        <div>
          <p className="eyebrow">Separate from your submission</p>
          <h2 id="candidate-clarifications-title">
            Follow-up from the evaluator
          </h2>
        </div>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => void refresh()}
        >
          Check again
        </button>
      </div>
      <p>
        These questions and your replies are a separate conversation. They do
        not reopen your workspace or change submitted files, activity, tests, or
        timing.
      </p>
      {error ? (
        <p className="review-workflow-error" role="alert">
          {error}
        </p>
      ) : null}
      {status ? (
        <p className="review-workflow-status" role="status">
          {status}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p>No follow-up requests are waiting.</p>
      ) : (
        <ol className="candidate-clarification-list">
          {items.map((item) => (
            <li key={item.id}>
              <p className="candidate-clarification-label">
                Evaluator question
              </p>
              <blockquote>{item.prompt}</blockquote>
              {item.reply ? (
                <div className="candidate-clarification-recorded">
                  <p className="candidate-clarification-label">Your reply</p>
                  <p>{item.reply}</p>
                </div>
              ) : item.closedAt ? (
                <p>This request was closed without a reply.</p>
              ) : (
                <>
                  <label htmlFor={`candidate-reply-${item.id}`}>
                    Your reply <span>Up to 1,600 characters</span>
                  </label>
                  <textarea
                    id={`candidate-reply-${item.id}`}
                    maxLength={1600}
                    rows={4}
                    value={drafts[item.id] ?? ''}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [item.id]: event.target.value,
                      }))
                    }
                  />
                  <div className="review-workflow-controls">
                    <span>{(drafts[item.id] ?? '').length}/1,600</span>
                    <button
                      type="button"
                      className="button button-primary"
                      disabled={busyId !== null || !drafts[item.id]?.trim()}
                      onClick={() => void sendReply(item)}
                    >
                      {busyId === item.id ? 'Recording…' : 'Record reply'}
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};
