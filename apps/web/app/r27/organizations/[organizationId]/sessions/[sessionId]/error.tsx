'use client';

export default function R27EvidenceError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  return (
    <main
      className="software-product evaluator-pending-review"
      style={{ padding: 'clamp(1.25rem, 3vw, 2.5rem)' }}
      role="alert"
    >
      <div
        className="evaluator-review-card"
        style={{ maxWidth: '40rem', marginInline: 'auto', padding: '1.5rem' }}
      >
        <h1>Couldn&apos;t load session evidence</h1>
        <p>
          We couldn&apos;t fetch this session right now. Recorded evidence is
          untouched — try again.
        </p>
        <button
          type="button"
          className="hiring-btn hiring-btn-primary"
          onClick={reset}
        >
          Retry
        </button>
      </div>
    </main>
  );
}
