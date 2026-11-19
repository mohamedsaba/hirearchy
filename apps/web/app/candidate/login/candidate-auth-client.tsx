'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ThemeToggle } from '../../_components/theme-toggle';
import { PasswordToggleInput } from '../../_components/password-field';

export interface CandidateAuthClientProps {
  readonly mode: 'login' | 'signup';
  readonly nextPath: string;
}

export function CandidateAuthClient({
  mode,
  nextPath,
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
          `/r23/verify-email?email=${encodeURIComponent(email.trim().toLowerCase())}`,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="hiring-auth-page hiring-auth-page--candidate software-product">
      <div className="hiring-auth-split">
        <aside
          className="hiring-auth-visual"
          aria-label="Candidate workspace overview"
        >
          <div
            className="hiring-auth-aura hiring-auth-aura--mint"
            aria-hidden="true"
          />
          <div
            className="hiring-auth-aura hiring-auth-aura--plum"
            aria-hidden="true"
          />
          <div className="hiring-auth-grid" aria-hidden="true" />

          <div className="hiring-auth-visual-inner">
            <div className="hiring-auth-brand">
              <span className="hiring-auth-brand-name">Hirearchy</span>
              <span className="software-product-capsule">Candidate</span>
            </div>

            <div className="hiring-auth-hero-copy">
              <span className="hiring-eyebrow hiring-eyebrow--mint">
                {mode === 'login'
                  ? 'Independent Assessment Gate'
                  : 'Verified Candidate Registry'}
              </span>
              <h1>
                {mode === 'login'
                  ? 'Proof of how you engineer.'
                  : 'Build your verified record.'}
              </h1>
              <p>
                {mode === 'login'
                  ? 'Open assigned technical challenges in an isolated repository workspace, manage every company invite in one queue, and read published evaluator decisions.'
                  : 'Verify your identity once to receive engineering challenges from hiring teams and track feedback clearly across every company.'}
              </p>
            </div>

            <div className="hiring-auth-preview-card" aria-hidden="true">
              <div className="hiring-auth-preview-head">
                <span className="hiring-auth-preview-title">
                  Candidate Dossier Pass
                </span>
                <span className="hiring-auth-preview-status">
                  <span className="hiring-live-dot" /> Verified Gate
                </span>
              </div>
              <dl className="hiring-auth-preview-list">
                <div>
                  <dt>Identity baseline</dt>
                  <dd>Profile, birth year, location &amp; government ID</dd>
                </div>
                <div>
                  <dt>Work environment</dt>
                  <dd>Timed repository workspace &amp; live terminal</dd>
                </div>
                <div>
                  <dt>Outcome clarity</dt>
                  <dd>Published status with strengths &amp; growth notes</dd>
                </div>
              </dl>
            </div>

            <div className="hiring-auth-corner-bracket" aria-hidden="true" />
          </div>
        </aside>

        <section
          className="hiring-auth-main"
          aria-labelledby="candidate-auth-title"
        >
          <div className="hiring-auth-topbar">
            <span className="hiring-auth-portal-badge">
              <span className="hiring-live-dot" aria-hidden="true" />
              Candidate Portal
            </span>
            <ThemeToggle variant="header" />
          </div>

          <div className="hiring-auth-card-wrap">
            <div className="hiring-auth-card">
              <div className="hiring-auth-card-head">
                <span className="hiring-eyebrow">
                  {mode === 'login' ? 'Welcome back' : 'Get started'}
                </span>
                <h2 id="candidate-auth-title">
                  {mode === 'login'
                    ? 'Sign in to your candidate account'
                    : 'Create your candidate account'}
                </h2>
                <p>
                  {mode === 'login'
                    ? 'Use the email address your hiring invitation was sent to.'
                    : 'Register with the email where you received your invitation.'}
                </p>
              </div>

              {errorMsg ? (
                <div
                  className="hiring-banner hiring-banner-danger"
                  role="alert"
                >
                  <div>
                    {errorMsg}{' '}
                    {verifyUrl ? (
                      <a href={verifyUrl}>Confirm email address →</a>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {signupSuccess ? (
                <div
                  className="hiring-banner hiring-banner-success"
                  role="status"
                >
                  <div className="hiring-stack-xs">
                    <strong>Confirm email for {signupSuccess.email}</strong>
                    <span>
                      Open your confirmation link to activate your candidate
                      account, then sign in.
                    </span>
                    <div className="hiring-header-actions">
                      {signupSuccess.confirmationInboxUrl ? (
                        <a
                          className="hiring-btn hiring-btn-primary hiring-btn-sm"
                          href={signupSuccess.confirmationInboxUrl}
                        >
                          Open Local Inbox for {signupSuccess.email}
                        </a>
                      ) : (
                        <a
                          className="hiring-btn hiring-btn-primary hiring-btn-sm"
                          href={signupSuccess.verifyEmailUrl}
                        >
                          Verify Email Address
                        </a>
                      )}
                      <Link
                        className="hiring-btn hiring-btn-sm"
                        href={`/candidate/login?next=${encodeURIComponent(nextPath)}`}
                      >
                        Sign In After Confirming
                      </Link>
                    </div>
                  </div>
                </div>
              ) : null}

              <form onSubmit={handleSubmit} className="hiring-auth-form">
                <div className="hiring-field">
                  <label htmlFor="cand-email">Email address</label>
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
                      id="cand-email"
                      type="email"
                      required
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                    />
                  </div>
                </div>

                <div className="hiring-field">
                  <label htmlFor="cand-password">Password</label>
                  <PasswordToggleInput
                    id="cand-password"
                    autoComplete={
                      mode === 'login' ? 'current-password' : 'new-password'
                    }
                    required
                    minLength={6}
                    value={password}
                    onChange={setPassword}
                    placeholder="At least 6 characters"
                    hasIcon
                  />
                </div>

                <button
                  type="submit"
                  className="hiring-btn hiring-btn-primary hiring-btn-block"
                  disabled={busy}
                >
                  {busy
                    ? mode === 'login'
                      ? 'Signing in...'
                      : 'Creating account...'
                    : mode === 'login'
                      ? 'Sign in to Candidate Portal'
                      : 'Create Candidate Account'}
                </button>
              </form>

              <footer className="hiring-auth-card-footer">
                {mode === 'login' ? (
                  <span>
                    New candidate?{' '}
                    <Link
                      href={`/candidate/signup?next=${encodeURIComponent(nextPath)}`}
                    >
                      Create candidate account
                    </Link>
                  </span>
                ) : (
                  <span>
                    Already registered?{' '}
                    <Link
                      href={`/candidate/login?next=${encodeURIComponent(nextPath)}`}
                    >
                      Sign in
                    </Link>
                  </span>
                )}
              </footer>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
