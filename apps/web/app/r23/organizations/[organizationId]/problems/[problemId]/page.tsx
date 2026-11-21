import Link from 'next/link';
import type { R211ReusableProblem } from '../../../../../../src/r211-builder/contract';
import { DeferredProblemRead } from '../deferred-problem-read';
import { loadProblems } from '../load-problems';
import { ProblemEditor } from '../problems-client';
import '../problems.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Manage problem' };
export default async function ProblemDetailPage({
  params,
}: {
  params: Promise<{ organizationId: string; problemId: string }>;
}) {
  const { organizationId, problemId } = await params;
  const { response, csrfToken } = await loadProblems(organizationId, problemId);
  const data: { problem: R211ReusableProblem } | null = response
    ? await response.json()
    : null;
  const workspace = `/r23/organizations/${encodeURIComponent(organizationId)}`;
  return (
    <main className="problems-page">
      <nav aria-label="Organization navigation">
        <Link href={workspace}>Organization workspace</Link>
        <Link href={workspace + '/problems'}>All problems</Link>
        <Link href={workspace + '/builder'}>Assessment builder</Link>
      </nav>
      {data ? (
        <ProblemEditor
          key={data.problem.id}
          problem={data.problem}
          csrfToken={csrfToken}
        />
      ) : (
        <DeferredProblemRead
          key={organizationId + '/' + problemId}
          organizationId={organizationId}
          problemId={problemId}
          csrfToken={csrfToken}
        />
      )}
    </main>
  );
}
