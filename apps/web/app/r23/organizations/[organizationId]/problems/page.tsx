import Link from 'next/link';
import type { R211ReusableProblem } from '../../../../../src/r211-builder/contract';
import { DeferredProblemRead } from './deferred-problem-read';
import { ProblemsTable } from './problems-table';
import { loadProblems } from './load-problems';
import { OrgBenchmarksStrip } from '../../../_components/org-benchmarks-strip';
import './problems.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Problems' };
export default async function ProblemsPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  const workspace = `/r23/organizations/${encodeURIComponent(organizationId)}`;
  const { response, csrfToken } = await loadProblems(organizationId);
  const data: { problems: R211ReusableProblem[] } | null = response
    ? await response.json()
    : null;
  return (
    <main className="problems-page">
      <Link href={workspace}>Organization workspace</Link>
      <header>
        <h1>Problems</h1>
        <Link
          className="button button-primary"
          href={workspace + '/builder?mode=new'}
        >
          Create a problem
        </Link>
      </header>
      <OrgBenchmarksStrip organizationId={organizationId} showProblemHealth />
      {data ? (
        <ProblemsTable workspace={workspace} problems={data.problems} />
      ) : (
        <DeferredProblemRead
          key={organizationId}
          organizationId={organizationId}
          csrfToken={csrfToken}
        />
      )}
    </main>
  );
}
