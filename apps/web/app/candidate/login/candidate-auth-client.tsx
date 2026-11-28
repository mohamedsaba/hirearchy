'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconLoader2,
} from '@tabler/icons-react';
import {
  candidateConfirmationParams,
  candidateRecoveryPath,
  candidateSignInPath,
} from '../../../src/hiring/candidate-entry';
import { useRouter } from 'next/navigation';
import { AuthCanvasBackdrop } from '../../_components/auth-canvas-backdrop';
import { ThemeToggle } from '../../_components/theme-toggle';
import { PasswordToggleInput } from '../../_components/password-field';
import { SwitchSignInAccount } from '../../_components/switch-sign-in-account';

export interface CandidateAuthClientProps {
  readonly mode: 'login' | 'signup';
  readonly nextPath: string;
  readonly verified?: boolean;
  readonly reset?: boolean;
  readonly activeAccount?: {
    email: string;
    csrfToken: string;
    hasCandidateContext?: boolean;
    hasTeamWorkspace?: boolean;
  } | null;
}

export function CandidateAuthClient({
  mode,
  nextPath,
  verified = false,
  reset = false,
  activeAccount,
}: CandidateAuthClientProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [verifyUrl, setVerifyUrl] = useState<string | null>(null);
  const [signupSuccess, setSignupSuccess] = useState<{
    email: string;
    confirmationInboxUrl: string | null;
    verifyEmailUrl: string;
  } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setVerifyUrl(null);
    setBusy(true);
    try {
      const response = await fetch('/api/candidate-portal', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          action: mode,
          email: email.trim().toLowerCase(),
          password,
          next: nextPath,
        }),
      });
      const data = (await response.json().catch(() => null)) as {
        ok?: boolean;
        redirectTo?: string;
        email?: string;
        confirmationInboxUrl?: string | null;
        verifyEmailUrl?: string;
        error?: { code?: string; message?: string; verifyUrl?: string };
      } | null;

      if (!response.ok || !data?.ok) {
        if (data?.error?.verifyUrl) setVerifyUrl(data.error.verifyUrl);
        throw new Error(
          data?.error?.message ??
            (mode === 'login'
              ? 'Invalid email or password.'
              : 'Unable to create candidate account.'),
        );
      }

      if (mode === 'login') {
        const target = data.redirectTo ?? nextPath ?? '/candidate';
        if (target.includes('/r26/candidate/')) {
          window.location.assign(target);
        } else {
          router.push(target);
          router.refresh();
        }
        return;
      }

      setSignupSuccess({
        email: data.email ?? email.trim().toLowerCase(),
        confirmationInboxUrl: data.confirmationInboxUrl ?? null,
        verifyEmailUrl:
          data.verifyEmailUrl ??
          `/r23/verify-email?${candidateConfirmationParams(email.trim().toLowerCase(), nextPath)}`,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };

  const signIn = mode === 'login';
  const emailAction =
    signupSuccess?.confirmationInboxUrl ?? signupSuccess?.verifyEmailUrl;
  const loginPath = candidateSignInPath(nextPath);

  return (
    <div className="software-product software-document-access software-candidate-access">
      <AuthCanvasBackdrop />
      <a className="software-skip-link" href="#main-content">
        Skip to sign in
      </a>
      <header className="software-document-header">
        <Link
          className="software-document-wordmark"
          href="/candidate"
          aria-label="Hirearchy Software for candidates"
        >
          <span>Hirearchy</span>
          <span className="software-document-product">Software</span>
        </Link>
        <ThemeToggle variant="header" />
      </header>

      <main className="software-document-shell" id="main-content" tabIndex={-1}>
        <div className="software-candidate-intro">
          <p className="software-access-kicker">Candidate portal</p>
          <p className="software-access-principle">
            Work worth
            <br />
            <span>seeing.</span>
          </p>
          <p className="software-access-lead">
            Complete a realistic engineering task in a real workspace and share
            your work in full context.
          </p>
          <ol
            className="software-candidate-steps"
            aria-label="Assessment journey"
          >
            <li data-active={!signupSuccess ? 'true' : undefined}>
              Invitation
            </li>
            <li>Workspace</li>
            <li>Feedback</li>
          </ol>
        </div>

        <section
          className="software-document-panel"
          aria-labelledby="candidate-auth-title"
        >
          <ol
            className="software-candidate-steps-pill"
            aria-label="Assessment journey"
          >
            <li data-active={!signupSuccess ? 'true' : undefined}>
              <span className="software-step-num" aria-hidden="true">
                1
              </span>
              <span>Invitation</span>
            </li>
            <li className="software-step-sep" aria-hidden="true">
              →
            </li>
            <li>
              <span className="software-step-num" aria-hidden="true">
                2
              </span>
              <span>Workspace</span>
            </li>
            <li className="software-step-sep" aria-hidden="true">
              →
            </li>
            <li>
              <span className="software-step-num" aria-hidden="true">
                3
              </span>
              <span>Feedback</span>
            </li>
          </ol>
          <h1 id="candidate-auth-title">
            {signupSuccess
              ? 'Confirm your email'
              : signIn
                ? 'Candidate sign in'
                : 'Create a candidate account'}
          </h1>
          {verified ? (
            <div
              className="software-auth-banner software-auth-banner--success"
              role="status"
            >
              <IconCircleCheck
                size={18}
                stroke={2}
                className="software-auth-banner-icon"
                aria-hidden="true"
              />
              <span>Email confirmed. Sign in to continue.</span>
            </div>
          ) : null}
          {reset ? (
            <div
              className="software-auth-banner software-auth-banner--success"
              role="status"
            >
              <IconCircleCheck
                size={18}
                stroke={2}
                className="software-auth-banner-icon"
                aria-hidden="true"
              />
              <span>Password updated. Sign in to continue.</span>
            </div>
          ) : null}
          {errorMsg ? (
            <div
              className="software-auth-banner software-auth-banner--error"
              role="alert"
            >
              <IconAlertTriangle
                size={18}
                stroke={2}
                className="software-auth-banner-icon"
                aria-hidden="true"
              />
              <span>
                {errorMsg}
                {verifyUrl ? (
                  <>
                    {' '}
                    <Link href={verifyUrl}>Confirm your email</Link>
                  </>
                ) : null}
              </span>
            </div>
          ) : null}
          {activeAccount ? (
            <SwitchSignInAccount
              email={activeAccount.email}
              csrfToken={activeAccount.csrfToken}
              signInPath={loginPath}
              continuePath={
                nextPath === '/candidate' && activeAccount.hasCandidateContext
                  ? '/candidate'
                  : undefined
              }
              switchLabel="Switch to your invited email"
              notice={
                activeAccount.hasCandidateContext
                  ? undefined
                  : nextPath === '/candidate'
                    ? `No candidate invitation or profile is linked to ${activeAccount.email}.`
                    : `This account does not match the invitation. Switch to the email address that received your assessment link.`
              }
              secondaryHref={
                activeAccount.hasTeamWorkspace
                  ? '/r23/organizations'
                  : undefined
              }
              secondaryLabel={
                activeAccount.hasTeamWorkspace
                  ? 'Back to team workspace'
                  : undefined
              }
            />
          ) : signupSuccess ? (
            <>
              <p>
                Confirm <strong>{signupSuccess.email}</strong> to open your
                assessments.
              </p>
              <nav aria-label="Verify your email">
                {emailAction ? (
                  <Link href={emailAction}>
                    {signupSuccess.confirmationInboxUrl
                      ? 'Open local inbox'
                      : 'Enter confirmation code'}
                  </Link>
                ) : null}
                <Link href={loginPath}>Return to candidate sign in</Link>
              </nav>
            </>
          ) : (
            <>
              <p>Use the email address that received your invitation.</p>
              <form onSubmit={handleSubmit}>
                <label htmlFor="cand-email">Email</label>
                <input
                  id="cand-email"
                  name="email"
                  type="email"
                  required
                  autoComplete="username"
                  maxLength={320}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
                {signIn ? (
                  <div className="software-field-heading">
                    <label htmlFor="cand-password">Password</label>
                    <Link
                      href={candidateRecoveryPath(nextPath)}
                      prefetch={false}
                    >
                      Forgot password?
                    </Link>
                  </div>
                ) : (
                  <label htmlFor="cand-password">Password</label>
                )}
                <PasswordToggleInput
                  id="cand-password"
                  name="password"
                  autoComplete={signIn ? 'current-password' : 'new-password'}
                  minLength={signIn ? undefined : 6}
                  maxLength={1024}
                  value={password}
                  onChange={setPassword}
                />
                {!signIn ? (
                  <p className="hiring-field-hint">At least 6 characters.</p>
                ) : null}
                <button
                  type="submit"
                  className="software-submit-btn"
                  disabled={busy}
                  aria-busy={busy || undefined}
                  data-pending={busy ? 'true' : undefined}
                >
                  {busy ? (
                    <>
                      <IconLoader2
                        size={16}
                        stroke={2.1}
                        className="software-btn-spinner"
                        aria-hidden="true"
                      />
                      <span>
                        {signIn ? 'Signing in…' : 'Creating account…'}
                      </span>
                    </>
                  ) : signIn ? (
                    'Sign in'
                  ) : (
                    'Create account'
                  )}
                </button>
              </form>
              <nav aria-label="Account help">
                <div className="software-access-switch">
                  {signIn ? (
                    <Link
                      href={`/candidate/signup?next=${encodeURIComponent(nextPath)}`}
                    >
                      Create a candidate account
                    </Link>
                  ) : (
                    <Link href={loginPath}>Already registered? Sign in</Link>
                  )}
                  <p>
                    Hiring team? <Link href="/r23/login">Team sign in</Link>
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
