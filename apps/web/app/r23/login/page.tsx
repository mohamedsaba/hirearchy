import Link from 'next/link';
import { notFound } from 'next/navigation';

import { isAuthenticatedStaging } from '../../../src/runtime/profile';
import { isFounderUatEnabled } from '../../../src/runtime/founder-uat';
import { r23IsEnabled } from '../../../src/r23-auth/config';
import { ThemeToggle } from '../../_components/theme-toggle';
import { PasswordToggleInput } from '../../_components/password-field';
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
    <main className="software-product evaluator-product-shell software-access-page hiring-auth-page hiring-auth-page--evaluator">
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
        <ThemeToggle variant="header" />
      </header>
      <div className="evaluator-product-content hiring-evaluator-auth-content">
        <section
          className="evaluator-signin-panel hiring-evaluator-signin-panel"
          aria-labelledby="signin-title"
        >
          <div className="evaluator-signin-copy hiring-evaluator-signin-copy">
            <div
              className="hiring-auth-aura hiring-auth-aura--mint"
              aria-hidden="true"
            />
            <div className="hiring-evaluator-copy-inner">
              <p className="software-eyebrow">Hirearchy Software</p>
              <h1 id="signin-title">Sign in to your workspace</h1>
              <p>
                Author repository challenges, inspect chronological engineering
                evidence, and record human hiring decisions.
              </p>

              <div
                className="hiring-auth-preview-card hiring-auth-preview-card--compact"
                aria-hidden="true"
              >
                <div className="hiring-auth-preview-head">
                  <span className="hiring-auth-preview-title">
                    Evaluator Suite
                  </span>
                  <span className="hiring-auth-preview-status">
                    <span className="hiring-live-dot" /> Evidence First
                  </span>
                </div>
                <dl className="hiring-auth-preview-list">
                  <div>
                    <dt>Reconstruction</dt>
                    <dd>File edits, test runs &amp; command timing deltas</dd>
                  </div>
                  <div>
                    <dt>AI Signal (Ultra)</dt>
                    <dd>Kimi K3.1 Pro analytical evidence synthesis</dd>
                  </div>
                  <div>
                    <dt>Decision Gate</dt>
                    <dd>Human evaluator owns final feedback &amp; outcome</dd>
                  </div>
                </dl>
              </div>
            </div>
          </div>

          <div className="evaluator-signin-form hiring-evaluator-signin-form">
            <div className="hiring-auth-card-head">
              <span className="hiring-eyebrow">Hiring Team Access</span>
              <h2>Evaluator &amp; Organization Sign In</h2>
            </div>

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

              <div className="hiring-field">
                <label htmlFor="email">Work email</label>
                <div className="hiring-input-wrap has-leading-icon">
                  <span className="hiring-input-icon" aria-hidden="true">
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect width="20" height="16" x="2" y="4" rx="2" />
                      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                    </svg>
                  </span>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="username"
                    required
                    maxLength={320}
                    placeholder="you@company.com"
                  />
                </div>
              </div>

              <div className="software-password-field">
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
                  required
                  maxLength={1024}
                  placeholder="Enter your password"
                  hasIcon
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
              </nav>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
