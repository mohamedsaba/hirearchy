'use client';

export default function R27EvidenceError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  return (
    <main className="evaluator-review-card" role="alert">
      <h1>Submitted evidence is unavailable</h1>
      <p>
        The evidence service could not complete this authorized read. No
        evidence was substituted or reconstructed.
      </p>
      <button type="button" onClick={reset}>
        Retry
      </button>
    </main>
  );
}
