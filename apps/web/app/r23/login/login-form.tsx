'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { IconLoader2 } from '@tabler/icons-react';
import { PasswordToggleInput } from '../../_components/password-field';

export function R23LoginForm({
  safeNext,
}: Readonly<{
  safeNext: string | null;
}>) {
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const resetPending = () => setPending(false);
    window.addEventListener('pageshow', resetPending);
    return () => window.removeEventListener('pageshow', resetPending);
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (pending) {
      event.preventDefault();
      return;
    }
    setPending(true);
  };

  return (
    <form
      action="/r23/auth/login"
      method="post"
      aria-busy={pending || undefined}
      onSubmit={handleSubmit}
    >
      {safeNext ? <input type="hidden" name="next" value={safeNext} /> : null}
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
      <button
        type="submit"
        className="software-submit-btn"
        disabled={pending}
        aria-disabled={pending || undefined}
        data-pending={pending ? 'true' : undefined}
      >
        {pending ? (
          <>
            <IconLoader2
              size={16}
              stroke={2.1}
              className="software-btn-spinner"
              aria-hidden="true"
            />
            <span>Signing in…</span>
          </>
        ) : (
          'Sign in'
        )}
      </button>
    </form>
  );
}
