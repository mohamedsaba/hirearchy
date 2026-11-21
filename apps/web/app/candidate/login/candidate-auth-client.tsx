'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  candidateConfirmationParams,
  candidateSignInPath,
} from '../../../src/hiring/candidate-entry';
import { useRouter } from 'next/navigation';
import { ThemeToggle } from '../../_components/theme-toggle';
import { PasswordToggleInput } from '../../_components/password-field';

export interface CandidateAuthClientProps {
  readonly mode: 'login' | 'signup';
  readonly nextPath: string;
  readonly verified?: boolean;
}

export function CandidateAuthClient({
  mode,
  nextPath,
  verified = false,
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
          <p className="software-access-principle">
            Work worth
            <br />
            <span>seeing.</span>
          </p>
          <ol
            className="software-candidate-steps"
            aria-label="Assessment journey"
          >
            <li>Invitation</li>
            <li>Workspace</li>
            <li>Feedback</li>
          </ol>
        </div>

        <section
          className="software-document-panel"
          aria-labelledby="candidate-auth-title"
        >
          <h1 id="candidate-auth-title">
            {signupSuccess
              ? 'Confirm your email'
              : signIn
                ? 'Candidate sign in'
                : 'Create a candidate account'}
          </h1>
          {verified ? (
            <p role="status">Email confirmed. Sign in to continue.</p>
          ) : null}
          {errorMsg ? (
            <p role="alert">
              {errorMsg}
              {verifyUrl ? (
                <>
                  {' '}
                  <Link href={verifyUrl}>Confirm your email</Link>
                </>
              ) : null}
            </p>
          ) : null}
          {signupSuccess ? (
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
                <label htmlFor="cand-password">Password</label>
                <PasswordToggleInput
                  id="cand-password"
                  name="password"
                  autoComplete={signIn ? 'current-password' : 'new-password'}
                  minLength={signIn ? undefined : 6}
                  maxLength={1024}
                  value={password}
                  onChange={setPassword}
                />
                <button type="submit" disabled={busy}>
                  {busy
                    ? signIn
                      ? 'Signing in…'
                      : 'Creating account…'
                    : signIn
                      ? 'Sign in'
                      : 'Create account'}
                </button>
              </form>
              <nav aria-label="Account help">
                {signIn ? (
                  <Link
                    href={`/candidate/signup?next=${encodeURIComponent(nextPath)}`}
                  >
                    Create a candidate account
                  </Link>
                ) : (
                  <Link href={loginPath}>Already registered? Sign in</Link>
                )}
              </nav>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
