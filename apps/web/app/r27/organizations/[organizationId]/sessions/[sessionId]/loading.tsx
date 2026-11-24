export default function R27EvidenceLoading() {
  return (
    <main
      className="software-product evaluator-pending-review"
      style={{ padding: 'clamp(1.25rem, 3vw, 2.5rem)' }}
      aria-busy="true"
      aria-label="Loading session evidence"
    >
      <div
        className="evaluator-review-card"
        style={{
          maxWidth: '72rem',
          marginInline: 'auto',
          padding: '1.5rem',
          display: 'grid',
          gap: '1rem',
        }}
      >
        <div
          className="software-skeleton"
          style={{ height: '1.75rem', width: '42%' }}
        />
        <div
          className="software-skeleton"
          style={{ height: '1rem', width: '64%' }}
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))',
            gap: '1rem',
            marginTop: '0.5rem',
          }}
        >
          <div className="software-skeleton" style={{ height: '11rem' }} />
          <div className="software-skeleton" style={{ height: '11rem' }} />
        </div>
      </div>
    </main>
  );
}
