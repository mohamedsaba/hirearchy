import { cookies } from 'next/headers';
import Link from 'next/link';

import {
  evaluatorCookieName,
  isEvaluatorCookieValid,
} from '../../../src/access/evaluator-access';
import { EvaluatorAccessForm } from '../evaluator-access-form';
import { SoftwareProductHeader } from '../software-product-header';
import { EvaluatorAssessmentList } from './evaluator-assessment-list';
import '../evaluator-product.css';

export const dynamic = 'force-dynamic';

const EvaluatorAssessmentsPage = async () => {
  const cookieStore = await cookies();
  const authenticated = isEvaluatorCookieValid(
    cookieStore.get(evaluatorCookieName)?.value,
  );

  return (
    <main className="software-product evaluator-product-shell">
      <SoftwareProductHeader active="assessments" />
      <div className="evaluator-product-content evaluator-assessments-content">
        {authenticated ? (
          <>
            <section
              className="evaluator-page-intro evaluator-assessments-intro"
              aria-labelledby="assessments-title"
            >
              <div>
                <p className="software-eyebrow">Evaluator workspace</p>
                <h1 id="assessments-title">Assessment lifecycle</h1>
                <p>Issued, active, and submitted sessions.</p>
              </div>
              <div className="evaluator-page-actions">
                <Link
                  className="software-button software-button-secondary"
                  href="/evaluator"
                >
                  Submitted reviews
                </Link>
                <Link
                  className="software-button software-button-primary"
                  href="/evaluator/assessments/new"
                >
                  Create assessment
                </Link>
              </div>
            </section>
            <EvaluatorAssessmentList />
          </>
        ) : (
          <section
            className="evaluator-signin-panel"
            aria-labelledby="access-title"
          >
            <div className="evaluator-signin-copy">
              <p className="software-eyebrow">Evaluator access</p>
              <h1 id="access-title">Assessment lifecycle.</h1>
              <p>
                Sign in to view active, submitted, and awaiting assessments.
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

export default EvaluatorAssessmentsPage;
