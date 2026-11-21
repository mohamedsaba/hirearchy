'use client';
import { useEffect, useRef, useState } from 'react';
import { notFound, redirect } from 'next/navigation';
import type { R211ReusableProblem } from '../../../../../src/r211-builder/contract';
import { ProblemEditor } from './problems-client';
import { ProblemsTable } from './problems-table';

type Data =
  { problem: R211ReusableProblem } | { problems: R211ReusableProblem[] };
async function readInBrowser(path: string): Promise<Data | number> {
  const response = await fetch(path, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) return response.status;
  return response.json();
}
export function DeferredProblemRead({
  organizationId,
  problemId,
  csrfToken,
}: {
  organizationId: string;
  problemId?: string;
  csrfToken: string;
}) {
  const org = encodeURIComponent(organizationId);
  const path =
    `/r23/api/organizations/${org}/problems` +
    (problemId ? '/' + encodeURIComponent(problemId) : '');
  const [result, setResult] = useState<Data | number | null>(null);
  const read = useRef<Promise<Data | number> | null>(null);
  useEffect(() => {
    let active = true;
    // The browser installs Set-Cookie before this read resolves. Share a single
    // renewal if React subscribes to the same keyed page more than once.
    read.current ??= readInBrowser(path);
    void read.current.then(
      (value) => {
        if (active) setResult(value);
      },
      () => {
        if (active) setResult(503);
      },
    );
    return () => {
      active = false;
    };
  }, [path]);
  if (result === null) return <p role="status">Loading saved problems…</p>;
  if (result === 401) redirect('/r23/login');
  if (result === 403 || result === 404) notFound();
  if (typeof result === 'number')
    return (
      <p role="alert">
        Could not load the saved problems. Reload the page to try again.
      </p>
    );
  return 'problem' in result ? (
    <ProblemEditor problem={result.problem} csrfToken={csrfToken} />
  ) : (
    <ProblemsTable
      workspace={`/r23/organizations/${org}`}
      problems={result.problems}
    />
  );
}
