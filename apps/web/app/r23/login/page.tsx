import { SoftwareMark } from '../../../src/ui/software-mark';
import {
  IconArrowRight,
  IconBraces,
  IconGitCommit,
  IconListCheck,
} from '@tabler/icons-react';
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
    <main className="software-product software-signin">
      <header className="software-signin-brand">
        <Link
          className="software-document-wordmark"
          href={founderUat ? '/' : '/r23/login'}
          prefetch={false}
          aria-label="Hirearchy Software home"
        >
          <SoftwareMark />
          <span>Hirearchy</span>
          <span className="software-document-product">Software</span>
        </Link>
      </header>
      <div className="software-signin-layout">
        <section
          className="evaluator-signin-panel"
          aria-labelledby="signin-title"
        >
          <div className="evaluator-signin-copy">
            <h1 id="signin-title">Sign in to your workspace</h1>
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
                Sign in <IconArrowRight aria-hidden="true" size={18} />
              </button>
            </form>
            {founderUat && (
              <p className="software-signin-signup">
                New to Hirearchy?{' '}
                <Link href="/r23/signup" prefetch={false}>
                  Sign up
                </Link>
              </p>
            )}
          </div>
        </section>
        <aside className="software-signin-story" aria-label="About Hirearchy">
          <div className="software-story-art" aria-hidden="true">
            <span>
              <IconBraces />
            </span>
            <span>
              <IconGitCommit />
            </span>
            <span>
              <IconListCheck />
            </span>
          </div>
          <div className="software-story-copy">
            <p className="software-story-title">
              See how
              <br />
              engineers work.
            </p>
            <p>
              Give candidates real engineering tasks. Review the work behind the
              result.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}
