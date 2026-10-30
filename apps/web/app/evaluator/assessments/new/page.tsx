import { cookies } from 'next/headers';
import Link from 'next/link';
import '../../evaluator-product.css';

import {
  evaluatorCookieName,
  isEvaluatorCookieValid,
} from '../../../../src/access/evaluator-access';
import { AssessmentBuilder } from './assessment-builder';

export const dynamic = 'force-dynamic';

const NewAssessmentPage = async () => {
  const cookieStore = await cookies();
  if (!isEvaluatorCookieValid(cookieStore.get(evaluatorCookieName)?.value)) {
    return (
      <main className="access-shell">
        <section className="access-card assessment-access-card">
          <p className="eyebrow">Evaluator access</p>
          <h1>Sign in to create an assessment.</h1>
          <p className="brief-copy">
            Assessment setup is available from the evaluator workspace.
          </p>
          <Link className="button button-primary" href="/evaluator">
            Go to evaluator access
          </Link>
        </section>
      </main>
    );
  }

  return <AssessmentBuilder />;
};

export default NewAssessmentPage;
