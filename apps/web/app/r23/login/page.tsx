import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import {
  isAuthenticatedStaging,
  isHiringPlatformEnabled,
} from '../../../src/runtime/profile';
import { isFounderUatEnabled } from '../../../src/runtime/founder-uat';
import { r23IsEnabled } from '../../../src/r23-auth/config';
import {
  sanitizePostLoginPath,
  tryReadHiringAccountFromCookie,
  tryResolveSignedInLandingPath,
} from '../../../src/staging/browser';
import { AuthCanvasBackdrop } from '../../_components/auth-canvas-backdrop';
import { ThemeToggle } from '../../_components/theme-toggle';
import { PasswordToggleInput } from '../../_components/password-field';
import { SwitchSignInAccount } from '../../_components/switch-sign-in-account';

export const metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

type SearchParams = {
  verified?: string;
  reset?: string;
  error?: string;
  next?: string;
  redirect?: string;
};

export default async function R23LoginPage({
  searchParams,
}: Readonly<{ searchParams: Promise<SearchParams> }>) {
  const founderUat = isFounderUatEnabled();
  if (!founderUat && !isAuthenticatedStaging() && !r23IsEnabled()) notFound();
  const params = await searchParams;
  const safeNext = sanitizePostLoginPath(params.next ?? params.redirect);

  let activeAccount: Awaited<
    ReturnType<typeof tryReadHiringAccountFromCookie>
  > = null;
  if (isHiringPlatformEnabled() && isAuthenticatedStaging()) {
    const jar = await cookies();
    const signedInTarget = await tryResolveSignedInLandingPath(
      jar.toString(),
      safeNext,
    ).catch(() => null);
    if (signedInTarget) {
      redirect(signedInTarget);
    }
    activeAccount = await tryReadHiringAccountFromCookie(jar.toString());
  }
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
      <AuthCanvasBackdrop />
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
        <div className="software-access-intro">
          <p className="software-access-kicker">Engineering evaluation</p>
          <p className="software-access-principle">
            Evidence informs.
            <br />
            <span>People decide.</span>
          </p>
          <p className="software-access-lead">
            Review real codebase work, inspect reconstructed timelines, and lead
            structured hiring discussions.
          </p>
        </div>
        <section
          className="software-document-panel"
          aria-labelledby="signin-title"
        >
          <h1 id="signin-title">Team sign in</h1>
          {activeAccount?.identity.email ? (
            <SwitchSignInAccount
              email={activeAccount.identity.email}
              csrfToken={activeAccount.csrfToken}
              signInPath={
                safeNext
                  ? `/r23/login?next=${encodeURIComponent(safeNext)}`
                  : '/r23/login'
              }
            />
          ) : (
            <>
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
                  <Link
                    href={
                      safeNext
                        ? `/r23/recover?next=${encodeURIComponent(safeNext)}`
                        : '/r23/recover'
                    }
                    prefetch={false}
                  >
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
              <nav aria-label="Account help">
                <div className="software-access-switch">
                  {founderUat ||
                  process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED ===
                    'true' ? (
                    <p>
                      New to Hirearchy?{' '}
                      <Link
                        href={
                          safeNext
                            ? `/r23/signup?next=${encodeURIComponent(safeNext)}`
                            : '/r23/signup'
                        }
                        prefetch={false}
                      >
                        Create an account
                      </Link>
                    </p>
                  ) : null}
                  <p>
                    Taking an assessment?{' '}
                    <Link href="/candidate/login" prefetch={false}>
                      Candidate sign in
                    </Link>
                  </p>
                </div>
              </nav>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
