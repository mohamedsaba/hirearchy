import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  isAuthenticatedStaging,
  isHiringPlatformEnabled,
} from '../../../src/runtime/profile';
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
    <main className="software-product evaluator-product-shell software-access-page">
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
            <p className="software-eyebrow">Hirearchy Software</p>
            <h1 id="signin-title">Sign in to your workspace</h1>
            <p>Prepare an assessment or pick up an assigned review.</p>
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
              <div className="software-password-field">
                <div className="software-field-heading">
                  <label htmlFor="password">Password</label>
                  <Link href="/r23/recover" prefetch={false}>
                    Reset your password
                  </Link>
                </div>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={1024}
                />
              </div>
              <button type="submit" className="button-primary">
                Sign in
              </button>
            </form>
            {founderUat ||
            process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED === 'true' ? (
              <nav aria-label="Account help">
                <p>
                  New to Hirearchy?{' '}
                  <Link href="/r23/signup" prefetch={false}>
                    Create an account
                  </Link>
                </p>
                {isHiringPlatformEnabled() ? (
                  <p>
                    Taking an assessment?{' '}
                    <Link href="/candidate/login" prefetch={false}>
                      Sign in to Candidate Portal →
                    </Link>
                  </p>
                ) : null}
              </nav>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
