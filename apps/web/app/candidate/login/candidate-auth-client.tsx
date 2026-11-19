'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

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
    <div className="hiring-gate-shell software-product">
      <div className="hiring-gate-card">
        <div>
          <span className="hiring-eyebrow">Hirearchy Candidate Portal</span>
          <h1 style={{ margin: '6px 0 0', fontSize: '26px' }}>
            {mode === 'login'
              ? 'Sign in as a candidate'
              : 'Create your candidate account'}
          </h1>
          <p
            style={{
              fontSize: '14px',
              color: 'var(--software-muted)',
              marginTop: '6px',
            }}
          >
            {mode === 'login'
              ? 'Access issued technical assessments, complete your verified profile, and review published feedback across companies.'
              : 'Verify your identity once and track every engineering assessment you take across Hirearchy.'}
          </p>
        </div>

        {errorMsg ? (
          <div className="hiring-banner hiring-banner-danger" role="alert">
            <div>
              {errorMsg}{' '}
              {verifyUrl ? (
                <a href={verifyUrl}>Confirm email address →</a>
              ) : null}
            </div>
          </div>
        ) : null}

        {signupSuccess ? (
          <div className="hiring-banner hiring-banner-success" role="status">
            <div style={{ display: 'grid', gap: '8px' }}>
              <strong>Confirm email for {signupSuccess.email}</strong>
              <span>
                Open your confirmation link to activate your candidate account,
                then sign in.
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

        <form onSubmit={handleSubmit} className="hiring-page-shell">
          <div className="hiring-field">
            <label htmlFor="cand-email">Email address</label>
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

          <div className="hiring-field">
            <label htmlFor="cand-password">Password</label>
            <input
              id="cand-password"
              type="password"
              required
              minLength={6}
              autoComplete={
                mode === 'login' ? 'current-password' : 'new-password'
              }
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 6 characters"
            />
          </div>

          <button
            type="submit"
            className="hiring-btn hiring-btn-primary"
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

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            gap: '10px',
            paddingTop: '12px',
            borderTop: '1px solid var(--software-border-subtle)',
            fontSize: '13px',
          }}
        >
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
          <Link href="/r23/login">Hiring team sign in →</Link>
        </div>
      </div>
    </div>
  );
}
