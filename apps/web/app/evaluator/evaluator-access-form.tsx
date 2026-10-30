'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export const EvaluatorAccessForm = ({
  authenticated = false,
}: Readonly<{ authenticated?: boolean }>) => {
  const router = useRouter();
  const [sessionId, setSessionId] = useState('');
  const [credential, setCredential] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const openEvidence = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsBusy(true);
    setError(null);

    try {
      if (authenticated) {
        router.push(
          `/evaluator/sessions/${encodeURIComponent(sessionId.trim())}`,
        );
        return;
      }

      const response = await fetch('/api/evaluator/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential }),
      });
      if (!response.ok) {
        const result = (await response.json()) as {
          error?: { message?: string };
        };
        throw new Error(result.error?.message ?? 'Evaluator access failed.');
      }

      if (sessionId.trim()) {
        router.push(
          `/evaluator/sessions/${encodeURIComponent(sessionId.trim())}`,
        );
      } else {
        router.refresh();
      }
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Evaluator access failed.',
      );
      setIsBusy(false);
    }
  };

  return (
    <form className="access-form" onSubmit={openEvidence}>
      <label>
        {authenticated
          ? 'Known session reference'
          : 'Known session reference (optional)'}
        <input
          aria-describedby={
            error && authenticated ? 'evaluator-access-error' : undefined
          }
          aria-invalid={error && authenticated ? true : undefined}
          autoComplete="off"
          onChange={(event) => setSessionId(event.target.value)}
          required={authenticated}
          value={sessionId}
        />
      </label>
      {authenticated ? null : (
        <label>
          Evaluator credential
          <input
            aria-describedby={error ? 'evaluator-access-error' : undefined}
            aria-invalid={error ? true : undefined}
            autoComplete="current-password"
            onChange={(event) => setCredential(event.target.value)}
            required
            type="password"
            value={credential}
          />
        </label>
      )}
      <button className="button button-primary" disabled={isBusy} type="submit">
        {isBusy
          ? 'Checking access…'
          : authenticated
            ? 'Open known session'
            : sessionId.trim()
              ? 'Open known session'
              : 'Continue to review queue'}
      </button>
      {error ? (
        <p
          className="form-error"
          id="evaluator-access-error"
          role="alert"
          aria-live="assertive"
        >
          {error}
        </p>
      ) : null}
    </form>
  );
};
