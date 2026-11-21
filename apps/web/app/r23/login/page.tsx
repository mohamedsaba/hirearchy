import Link from 'next/link';
import { notFound } from 'next/navigation';

import { isAuthenticatedStaging } from '../../../src/runtime/profile';
import { isFounderUatEnabled } from '../../../src/runtime/founder-uat';
import { r23IsEnabled } from '../../../src/r23-auth/config';
import { sanitizePostLoginPath } from '../../../src/staging/browser';
import { ThemeToggle } from '../../_components/theme-toggle';
import { PasswordToggleInput } from '../../_components/password-field';

export const metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

type SearchParams = {
  verified?: string;
  reset?: string;
  error?: string;
  next?: string;
};

export default async function R23LoginPage({
  searchParams,
}: Readonly<{ searchParams: Promise<SearchParams> }>) {
  const founderUat = isFounderUatEnabled();
  if (!founderUat && !isAuthenticatedStaging() && !r23IsEnabled()) notFound();
  const params = await searchParams;
  const safeNext = sanitizePostLoginPath(params.next);
  const nextIsPeerReview = Boolean(
    safeNext && safeNext.includes('peerReview='),
  );
  const notice =
    params.verified === '1'
      ? 'Email confirmed. Sign in to continue.'
      : params.reset === '1'
        ? 'Password updated. Sign in with your new password.'
        : params.error === 'credentials'
          ? 'Sign-in failed. Check your email and password, and confirm your email address if you have not already.'
          : params.error === 'unavailable'
            ? 'Sign-in is temporarily unavailable. Try again shortly.'
            : nextIsPeerReview
              ? 'Sign in with your team account to open the requested peer review.'
              : safeNext
                ? 'Sign in with your team account to open this review.'
                : null;
  const noticeIsError =
    params.error === 'credentials' || params.error === 'unavailable';

  return (
    <div className="software-product software-document-access software-team-access">
      <a className="software-skip-link" href="#main-content">
        Skip to sign in
      </a>
      <header className="software-document-header">
        <Link
          className="software-document-wordmark"
          href={founderUat ? '/' : '/r23/login'}
          prefetch={false}
          aria-label="Hirearchy Software"
        >
          <span>Hirearchy</span>
          <span className="software-document-product">Software</span>
        </Link>
        <ThemeToggle variant="header" />
      </header>
      <main className="software-document-shell" id="main-content" tabIndex={-1}>
        <p className="software-access-principle">
          Evidence informs.
          <br />
          <span>People decide.</span>
        </p>
        <section
          className="software-document-panel"
          aria-labelledby="signin-title"
        >
          <h1 id="signin-title">Team sign in</h1>
          <p>Access your assessments and assigned reviews.</p>
          {notice ? (
            <p role={noticeIsError ? 'alert' : 'status'}>{notice}</p>
          ) : null}
          <form action="/r23/auth/login" method="post">
            {safeNext ? (
              <input type="hidden" name="next" value={safeNext} />
            ) : null}
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              maxLength={320}
            />
            <div className="software-field-heading">
              <label htmlFor="password">Password</label>
              <Link href="/r23/recover" prefetch={false}>
                Reset your password
              </Link>
            </div>
            <PasswordToggleInput
              id="password"
              name="password"
              autoComplete="current-password"
              maxLength={1024}
            />
            <button type="submit">Sign in</button>
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
            </nav>
          ) : null}
        </section>
      </main>
    </div>
  );
}
