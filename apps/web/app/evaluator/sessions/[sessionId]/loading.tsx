const EvaluatorReviewLoading = () => (
  <main className="software-product evaluator-review-shell" aria-busy="true">
    <div className="review-loading-state" role="status" aria-live="polite">
      <p className="eyebrow">Evaluator review</p>
      <h1>Opening the recorded session…</h1>
      <p>
        Recorded activity and submitted changes are being prepared for review.
      </p>
      <span className="summary-progress" aria-hidden="true" />
    </div>
  </main>
);

export default EvaluatorReviewLoading;
