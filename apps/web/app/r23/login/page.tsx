import Link from 'next/link';
import { notFound } from 'next/navigation';

import { isAuthenticatedStaging } from '../../../src/runtime/profile';
import { isFounderUatEnabled } from '../../../src/runtime/founder-uat';
import { r23IsEnabled } from '../../../src/r23-auth/config';
import '../../evaluator/evaluator-product.css';

export const dynamic = 'force-dynamic';

type SearchParams = {
  verified?: string;
  reset?: string;
  error?: string;
};

export default async function R23LoginPage({
  searchParams,
}: Readonly<{ searchParams: Promise<SearchParams> }>) {
  const founderUat = isFounderUatEnabled();
  if (!founderUat && !isAuthenticatedStaging() && !r23IsEnabled()) notFound();
  const params = await searchParams;
  const notice =
    params.verified === '1'
      ? 'Email confirmed. Sign in to continue.'
      : params.reset === '1'
        ? 'Password updated. Sign in with your new password.'
        : params.error === 'credentials'
          ? 'Sign-in failed. Check your email and password, and confirm your email address if you have not already.'
          : params.error === 'unavailable'
            ? 'Sign-in is temporarily unavailable. Try again shortly.'
            : null;
  const noticeIsError =
    params.error === 'credentials' || params.error === 'unavailable';

  return (
    <main className="software-product evaluator-product-shell">
      <header className="software-product-header">
        <Link
          className="software-wordmark"
          href={founderUat ? '/' : '/r23/login'}
          prefetch={false}
          aria-label="Hirearchy Software home"
        >
          <span>Hirearchy</span>
          <span className="software-product-capsule">Software</span>
        </Link>
      </header>
      <div className="evaluator-product-content">
        <section
          className="evaluator-signin-panel"
          aria-labelledby="signin-title"
        >
          <div className="evaluator-signin-copy">
            <p className="software-eyebrow">Your workspace</p>
            <h1 id="signin-title">Sign in to Hirearchy Software.</h1>
            <p>
              Manage assessments or review engineering work assigned to you.
            </p>
            <p className="evaluator-signin-note">
              Evidence informs the decision. You own the decision.
            </p>
          </div>
          <div className="evaluator-signin-form">
            <form
              action="/r23/auth/login"
              method="post"
              className="access-form"
            >
              {notice ? (
                <p role={noticeIsError ? 'alert' : 'status'} aria-live="polite">
                  {notice}
                </p>
              ) : null}
              <label htmlFor="email">
                Email
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  maxLength={320}
                />
              </label>
              <label htmlFor="password">
                Password
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={1024}
                />
              </label>
              <button type="submit" className="button-primary">
                Sign in
              </button>
            </form>
            <nav aria-label="Account help">
              {founderUat ? (
                <>
                  <p>
                    <Link href="/r23/signup" prefetch={false}>
                      Sign up
                    </Link>
                  </p>
                  <p>
                    <Link href="/r23/recover" prefetch={false}>
                      Reset your password
                    </Link>
                  </p>
                  <p>
                    <Link href="/r23/verify-email" prefetch={false}>
                      Verify your email
                    </Link>
                  </p>
                  <p>
                    <Link href="/r23/mail" prefetch={false}>
                      Local email inbox
                    </Link>
                  </p>
                </>
              ) : (
                <>
                  <p>
                    <Link href="/r23/recover" prefetch={false}>
                      Reset your password
                    </Link>
                  </p>
                  <p>
                    <Link href="/r23/verify-email" prefetch={false}>
                      Verify your email
                    </Link>
                  </p>
                </>
              )}
            </nav>
            {founderUat ? (
              <form action="/r23/mail" method="get" className="access-form">
                <label htmlFor="mailbox-email">
                  Local email inbox
                  <input
                    id="mailbox-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    maxLength={320}
                  />
                </label>
                <button type="submit" className="button-primary">
                  Open local inbox
                </button>
              </form>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
