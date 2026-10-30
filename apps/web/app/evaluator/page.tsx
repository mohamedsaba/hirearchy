import { cookies } from 'next/headers';
import Link from 'next/link';

import {
  evaluatorCookieName,
  isEvaluatorCookieValid,
} from '../../src/access/evaluator-access';
import { EvaluatorAccessForm } from './evaluator-access-form';
import { EvaluatorReviewQueue } from './evaluator-review-queue';
import { SoftwareProductHeader } from './software-product-header';
import './evaluator-product.css';

export const dynamic = 'force-dynamic';

const EvaluatorAccessPage = async () => {
  const cookieStore = await cookies();
  const authenticated = isEvaluatorCookieValid(
    cookieStore.get(evaluatorCookieName)?.value,
  );

  return (
    <main className="software-product evaluator-product-shell">
      <SoftwareProductHeader active="reviews" />
      <div className="evaluator-product-content">
        {authenticated ? (
          <>
            <section
              className="evaluator-page-intro"
              aria-labelledby="review-title"
            >
              <div>
                <p className="software-eyebrow">Evaluator workspace</p>
                <h1 id="review-title">Reviews</h1>
                <p>
                  Open submitted work, inspect its sources, and record your
                  decision.
                </p>
              </div>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                <Link
                  className="software-button software-button-secondary"
                  href="/evaluator/assessments"
                >
                  All assessments
                </Link>
                <Link
                  className="software-button software-button-primary"
                  href="/evaluator/assessments/new"
                >
                  Create assessment
                </Link>
              </div>
            </section>
            <section
              className="evaluator-queue-panel"
              aria-labelledby="queue-title"
            >
              <div className="evaluator-section-heading">
                <div>
                  <h2 id="queue-title">Submitted assessments</h2>
                  <p>
                    Each report is based on the evidence recorded for that
                    session.
                  </p>
                </div>
              </div>
              <EvaluatorReviewQueue />
            </section>
            <details className="evaluator-known-session">
              <summary>Open a known session reference</summary>
              <p>Use this when you have a direct session reference.</p>
              <EvaluatorAccessForm authenticated />
            </details>
          </>
        ) : (
          <section
            className="evaluator-signin-panel"
            aria-labelledby="access-title"
          >
            <div className="evaluator-signin-copy">
              <p className="software-eyebrow">Evaluator access</p>
              <h1 id="access-title">Review submitted work.</h1>
              <p>
                Sign in to open assessment reports and record your human review.
              </p>
              <p className="evaluator-signin-note">
                Assessment evidence informs the decision. You own the decision.
              </p>
            </div>
            <div className="evaluator-signin-form">
              <EvaluatorAccessForm />
            </div>
          </section>
        )}
      </div>
    </main>
  );
};

export default EvaluatorAccessPage;
