'use client';

import { useState } from 'react';
import Link from 'next/link';

export function SwitchSignInAccount({
  email,
  csrfToken,
  signInPath,
  continuePath,
}: Readonly<{
  email: string;
  csrfToken: string;
  signInPath: string;
  continuePath?: string;
}>) {
  const [state, setState] = useState<'idle' | 'pending' | 'error'>('idle');

  async function switchAccount() {
    setState('pending');
    try {
      const response = await fetch('/r23/auth/logout', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ csrf: csrfToken }),
      });
      if (!response.ok) {
        setState('error');
        return;
      }
      window.location.replace(signInPath);
    } catch {
      setState('error');
    }
  }

  return (
    <>
      <p>
        Signed in as <strong>{email}</strong>.
      </p>
      <div className="hiring-header-actions hiring-mt-sm">
        {continuePath ? (
          <Link className="hiring-btn hiring-btn-primary" href={continuePath}>
            Continue with this account
          </Link>
        ) : null}
        <button
          type="button"
          className={`hiring-btn${continuePath ? '' : ' hiring-btn-primary'}`}
          disabled={state === 'pending'}
          onClick={() => void switchAccount()}
        >
          {state === 'pending' ? 'Signing out…' : 'Use another account'}
        </button>
      </div>
      {state === 'error' ? (
        <p role="alert">Could not sign out. Try again.</p>
      ) : null}
    </>
  );
}
