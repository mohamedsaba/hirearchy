'use client';

import { useEffect, useRef, useState } from 'react';
import { redirect } from 'next/navigation';

export function RefreshBuilderSession({ csrfToken }: { csrfToken: string }) {
  const renewal = useRef<Promise<Response> | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    renewal.current ??= fetch('/r23/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'x-csrf-token': csrfToken },
    });
    void renewal.current.then(
      (response) => {
        if (!active) return;
        if (response.ok) window.location.reload();
        else setStatus(response.status);
      },
      () => {
        if (active) setStatus(503);
      },
    );
    return () => {
      active = false;
    };
  }, [csrfToken]);

  if (status === 401) redirect('/r23/login');
  if (status !== null)
    return (
      <p role="alert">
        Could not renew your session. Reload the page to try again.
      </p>
    );
  return <p role="status">Loading assessment builder…</p>;
}
